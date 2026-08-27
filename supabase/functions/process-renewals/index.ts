// supabase/functions/process-renewals/index.ts
//
// Scheduled function — NOT called by the website. Runs on a timer (e.g. once
// daily) and auto-creates the next order for any customer on auto-renew
// whose current supply is due to run out. The new order lands in the
// database as a normal pending order (same as if they'd ordered on the
// site) — you still confirm payment and notify them on WhatsApp yourself,
// since real automatic WhatsApp messaging needs the separate WhatsApp
// Business API, not covered here.
//
// Deploy: supabase functions deploy process-renewals
// Schedule: see the SQL at the bottom of this file's companion notes.

import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Shared secret so only your own cron job (not the public internet) can trigger this.
const RENEWAL_CRON_SECRET = Deno.env.get("RENEWAL_CRON_SECRET") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment configuration.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const db = supabase.schema("v2");

const MEMBER_DISCOUNT_RATE = 0.10;
const MILESTONE_DISCOUNT_RATE = 0.30;

const TUB_COST_KES = 3000;
const TUB_GRAMS = 410;
const PPG = TUB_COST_KES / TUB_GRAMS;
const MYLAR_SMALL = 1095 / 800;
const MYLAR_LARGE = 1095 / 400;
const BASE_PROFIT = 22;

const WEIGHT_CLASSES = [
  { name: "A", min: 30, max: 50, sachetG: 3.0, bonusProfit: 0 },
  { name: "B", min: 51, max: 67, sachetG: 4.5, bonusProfit: 2 },
  { name: "C", min: 68, max: 80, sachetG: 6.0, bonusProfit: 4 },
  { name: "D", min: 81, max: 100, sachetG: 7.5, bonusProfit: 6 },
  { name: "E", min: 101, max: 250, sachetG: 9.0, bonusProfit: 8 },
] as const;

function round2(v: number) { return Math.round((v + Number.EPSILON) * 100) / 100; }
function roundUpKES(v: number) { return Math.ceil(v - Number.EPSILON); }
function getWeightClassByName(name: string) { return WEIGHT_CLASSES.find((w) => w.name === name) ?? null; }
function getMylarCost(g: number) { return g <= 4.5 ? MYLAR_SMALL : MYLAR_LARGE; }
function getSachetCost(g: number) { return round2(PPG * g + getMylarCost(g)); }
function getSachetPrice(g: number, bonus = 0) { return roundUpKES(getSachetCost(g) + BASE_PROFIT + bonus); }

// Nairobi is UTC+3 year-round (no DST). We compare CALENDAR DAYS in Nairobi
// time, not exact timestamps — otherwise an order placed at 3pm wouldn't be
// "due" until 3pm on its due date, and a midnight cron run would miss it by
// up to a full day.
function nairobiDateOnly(d: Date): number {
  const nairobi = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return Date.UTC(nairobi.getUTCFullYear(), nairobi.getUTCMonth(), nairobi.getUTCDate());
}

async function countPaidOrders(phone: string): Promise<number> {
  const { count, error } = await db
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("phone_number", phone)
    .eq("status", "paid");
  if (error) throw new Error(`Count failed: ${error.message}`);
  return count || 0;
}

function calculateFinancials(args: {
  planType: "fast_saturation" | "daily_maintenance";
  weightClassName: string;
  durationDays: number;
  trainingDaysPerWeek: number | null;
  isVip: boolean;
  isMilestone: boolean;
}) {
  const wc = getWeightClassByName(args.weightClassName);
  if (!wc) throw new Error(`Unknown weight class: ${args.weightClassName}`);

  let grossAmount: number;
  let totalSachets: number;
  let trainingSachetDays = 0;
  let restSachetDays = 0;

  if (args.planType === "fast_saturation") {
    totalSachets = 20;
    grossAmount = round2(getSachetPrice(wc.sachetG, wc.bonusProfit) * totalSachets);
  } else {
    const trainingDaysPerWeek = args.trainingDaysPerWeek || 4;
    trainingSachetDays = Math.round((trainingDaysPerWeek / 7) * args.durationDays);
    restSachetDays = args.durationDays - trainingSachetDays;
    totalSachets = trainingSachetDays + restSachetDays;

    const trainingPrice = getSachetPrice(wc.sachetG, wc.bonusProfit) + 5;
    const restPrice = getSachetPrice(3.0, 0);
    grossAmount = round2(trainingSachetDays * trainingPrice + restSachetDays * restPrice);
  }

  let discountRate = 0;
  let discountApplied = "NONE";
  if (args.isMilestone) { discountRate = MILESTONE_DISCOUNT_RATE; discountApplied = "MILESTONE_30"; }
  else if (args.isVip) { discountRate = MEMBER_DISCOUNT_RATE; discountApplied = "VIP_10"; }

  const discountAmount = round2(grossAmount * discountRate);
  const netAmount = round2(grossAmount - discountAmount);

  return { grossAmount, discountAmount, netAmount, discountApplied, totalSachets, trainingSachetDays, restSachetDays };
}

serve(async (req: Request) => {
  try {
    // Simple shared-secret check so only your scheduler can trigger this endpoint.
    if (RENEWAL_CRON_SECRET) {
      const provided = req.headers.get("x-renewal-secret") ?? "";
      if (provided !== RENEWAL_CRON_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
    }

    const now = new Date();

    // Orders that are paid, on auto-renew, not cancelled, and haven't already
    // spawned their renewal order yet.
    const { data: dueCandidates, error: fetchError } = await db
      .from("orders")
      .select("*")
      .eq("status", "paid")
      .eq("auto_renew", true)
      .is("renewal_cancelled_at", null)
      .is("renewed_at", null);

    if (fetchError) throw new Error(`Fetch failed: ${fetchError.message}`);

    const results: Array<Record<string, unknown>> = [];

    for (const order of dueCandidates || []) {
      const durationDays = order.plan_type === "fast_saturation" ? 5 : (order.duration_days ?? 0);
      const createdAt = new Date(order.created_at);
      const dueDate = new Date(createdAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

      // Only process orders whose supply has actually run out (or runs out
      // today), comparing calendar days in Nairobi time — not exact
      // timestamps — so today's renewals are caught regardless of what time
      // of day the original order was placed.
      if (nairobiDateOnly(dueDate) > nairobiDateOnly(now)) continue;

      try {
        const paidCount = await countPaidOrders(order.phone_number);
        const isVip = paidCount >= 4;
        const isMilestone = isVip && ((paidCount - 3) % 4 === 0);

        const financials = calculateFinancials({
          planType: order.plan_type,
          weightClassName: order.weight_class,
          durationDays,
          trainingDaysPerWeek: order.training_days_per_week,
          isVip,
          isMilestone,
        });

        const newOrderId = crypto.randomUUID();

        const { data: newOrder, error: insertError } = await db
          .from("orders")
          .insert({
            client_order_id: newOrderId,
            user_id: order.user_id,
            phone_number: order.phone_number,
            plan_type: order.plan_type,
            plan_name: order.plan_name,
            weight_class: order.weight_class,
            body_weight_kg: order.body_weight_kg,
            duration_days: order.duration_days,
            training_days_per_week: order.training_days_per_week,
            total_sachets: financials.totalSachets,
            training_sachet_days: financials.trainingSachetDays,
            rest_sachet_days: financials.restSachetDays,
            location: order.location,
            gym: order.gym,
            message: "Auto-renewed order — awaiting customer confirmation and payment.",
            gross_amount: financials.grossAmount,
            discount_amount: financials.discountAmount,
            net_amount: financials.netAmount,
            total_kes: financials.netAmount,
            discount_applied: financials.discountApplied,
            is_milestone_reward: isMilestone,
            auto_renew: true,
            renewal_cancelled_at: null,
            renewed_at: null,
            renewed_from_order_id: order.id,
          })
          .select()
          .single();

        if (insertError || !newOrder) {
          throw new Error(insertError?.message ?? "Insert failed");
        }

        await db
          .from("orders")
          .update({ renewed_at: now.toISOString(), renewed_into_order_id: newOrder.id })
          .eq("id", order.id);

        results.push({ phone: order.phone_number, previous_order: order.client_order_id, new_order: newOrderId, status: "created" });
      } catch (err) {
        results.push({ phone: order.phone_number, previous_order: order.client_order_id, status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Renewal processor error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { status: 500 });
  }
});