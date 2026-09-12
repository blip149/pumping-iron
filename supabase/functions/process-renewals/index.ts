// supabase/functions/process-renewals/index.ts
//
// Scheduled function — NOT called by the website. Runs on a timer (e.g. once
// daily) and auto-creates the next order for any client on auto-renew whose
// current batch has finished its window. Saturation-aware: recomputes the
// client's LIVE status off the completing order (same model as index.ts's
// checkout) and decides the next order fresh each time —
//   - still building  -> another batch, same doses/day the client chose,
//                        sized to 7 days or however many days remain,
//                        whichever is smaller (this is what makes "weekly
//                        batching" work — each batch is its own real order
//                        with its own confirmed_at, set later by you)
//   - now saturated    -> switches automatically to the flat 1x/day
//                         maintenance batch — batching just stops on its
//                         own once the goal is reached
//
// New orders land as PENDING (confirmed_at: null) — you still deliver and
// call confirm_delivery yourself; that's the only place store_grams_at_last_order
// gets advanced, so this cron never touches it directly.
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

const FLAT_SACHET_GRAMS = 3.0;
const MAX_DOSES_PER_DAY = 7;
const MAINTENANCE_BATCH_DAYS = 14;
const WEEKLY_BATCH_DAYS = 7;
const MIN_BATCH_DAYS = 6; // a batch is never delivered as fewer than this many days
const DAILY_DECAY_RATE = 0.015;

function round2(v: number) { return Math.round((v + Number.EPSILON) * 100) / 100; }
function roundUpKES(v: number) { return Math.ceil(v - Number.EPSILON); }
function getMylarCost(g: number) { return g <= 4.5 ? MYLAR_SMALL : MYLAR_LARGE; }
function getSachetCost(g: number) { return round2(PPG * g + getMylarCost(g)); }
function getSachetPrice(g: number) { return roundUpKES(getSachetCost(g) + BASE_PROFIT); }

const FLAT_SACHET_PRICE = getSachetPrice(FLAT_SACHET_GRAMS);

function priceForNthDose(n: number): number {
  return round2(FLAT_SACHET_PRICE - 9 * ((n - 1) / n));
}

function dailyCostForDoses(dosesPerDay: number): number {
  let total = 0;
  for (let n = 1; n <= dosesPerDay; n++) total += priceForNthDose(n);
  return round2(total);
}

function saturationThresholdGrams(weightKg: number): number {
  return 84 * (weightKg / 70);
}

function decayStore(storeGrams: number, daysElapsed: number): number {
  if (daysElapsed <= 0) return storeGrams;
  return storeGrams * Math.pow(1 - DAILY_DECAY_RATE, daysElapsed);
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function simulateOrderWindow(args: {
  storeBefore: number;
  storeAsOfDate: Date;
  orderStart: Date;
  durationDays: number;
  totalGrams: number;
  threshold: number;
  simulateUpTo: Date;
}): number {
  const duration = Math.max(1, args.durationDays);
  const dailyDose = args.totalGrams / duration;
  const orderEnd = addDays(args.orderStart, duration);

  const gapDays = daysBetween(args.storeAsOfDate, args.orderStart);
  let store = gapDays > 0 ? decayStore(args.storeBefore, gapDays) : args.storeBefore;

  const simEnd = args.simulateUpTo < orderEnd ? args.simulateUpTo : orderEnd;
  const daysToSimulate = Math.max(0, Math.floor(daysBetween(args.orderStart, simEnd)));

  for (let day = 0; day < daysToSimulate; day++) {
    // Once at the ceiling, extra doses don't accumulate — they're excreted,
    // essentially immediately, since muscle uptake is already maxed out.
    store = Math.min(args.threshold, decayStore(store, 1) + dailyDose);
  }

  return store;
}

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

serve(async (req: Request) => {
  try {
    if (RENEWAL_CRON_SECRET) {
      const provided = req.headers.get("x-renewal-secret") ?? "";
      if (provided !== RENEWAL_CRON_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
    }

    const now = new Date();

    // Orders that are paid, on auto-renew, not cancelled, and haven't already
    // spawned their next batch yet.
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
      const durationDays = order.duration_days ?? 1;
      // Use confirmed_at (real delivery date) when available — falls back
      // to created_at only for orders placed before that column existed.
      const orderStart = new Date(order.confirmed_at ?? order.created_at);
      const dueDate = addDays(orderStart, durationDays);

      if (nairobiDateOnly(dueDate) > nairobiDateOnly(now)) continue;

      try {
        const { data: userRow, error: userError } = await db
          .from("users")
          .select("id, body_weight_kg, store_grams_at_last_order, store_reference_date")
          .eq("phone_number", order.phone_number)
          .maybeSingle();
        if (userError) throw new Error(`User lookup failed: ${userError.message}`);

        const weightKg = userRow?.body_weight_kg ?? order.body_weight_kg ?? 70;
        const threshold = saturationThresholdGrams(weightKg);

        const baseline = userRow?.store_grams_at_last_order ?? 0;
        const baselineDate = userRow?.store_reference_date ? new Date(userRow.store_reference_date) : orderStart;

        // This order's window has fully elapsed (that's why it's due) — run
        // it all the way through to see where the client's store actually
        // landed, which decides what the NEXT order should be.
        const currentStore = simulateOrderWindow({
          storeBefore: baseline,
          storeAsOfDate: baselineDate,
          orderStart,
          durationDays,
          totalGrams: order.grams_delivered ?? 0,
          threshold,
          simulateUpTo: addDays(orderStart, durationDays),
        });

        const isSaturated = currentStore >= threshold;
        const paidCount = await countPaidOrders(order.phone_number);
        const isVip = paidCount >= 4;
        const isMilestone = isVip && ((paidCount - 3) % 4 === 0);

        let nextDosesPerDay: number;
        let nextDurationDays: number;
        let nextPlanName: string;

        if (isSaturated) {
          nextDosesPerDay = 1;
          nextDurationDays = MAINTENANCE_BATCH_DAYS;
          nextPlanName = "Maintenance (1x/day)";
        } else {
          // Same pace the client originally chose for this batch.
          const previousDosesPerDay = Math.max(1, Math.round((order.total_sachets ?? 0) / durationDays));
          nextDosesPerDay = Math.min(MAX_DOSES_PER_DAY, previousDosesPerDay);

          const remainingGrams = Math.max(0, threshold - currentStore);
          const gramsPerDay = nextDosesPerDay * FLAT_SACHET_GRAMS;
          const daysStillNeeded = Math.max(1, Math.ceil(remainingGrams / gramsPerDay));

          // Cap each batch at a week, but never let a tail batch (the last
          // leg of a multi-week saturation journey) drop below
          // MIN_BATCH_DAYS — a shorter tail isn't worth a dedicated
          // delivery trip, so extend it instead of shipping it as-is.
          const cappedDuration = Math.min(WEEKLY_BATCH_DAYS, daysStillNeeded);
          nextDurationDays = Math.max(cappedDuration, MIN_BATCH_DAYS);
          nextPlanName = `Saturation Plan (${nextDosesPerDay}x/day)`;
        }

        const totalSachets = nextDosesPerDay * nextDurationDays;
        const gramsDelivered = round2(totalSachets * FLAT_SACHET_GRAMS);
        const dailyCost = dailyCostForDoses(nextDosesPerDay);
        const grossAmount = round2(dailyCost * nextDurationDays);

        let discountRate = 0;
        let discountApplied = "NONE";
        if (isMilestone) { discountRate = MILESTONE_DISCOUNT_RATE; discountApplied = "MILESTONE_30"; }
        else if (isVip) { discountRate = MEMBER_DISCOUNT_RATE; discountApplied = "VIP_10"; }

        const discountAmount = round2(grossAmount * discountRate);
        const netAmount = round2(grossAmount - discountAmount);

        const newOrderId = crypto.randomUUID();

        const { data: newOrder, error: insertError } = await db
          .from("orders")
          .insert({
            client_order_id: newOrderId,
            user_id: order.user_id,
            phone_number: order.phone_number,
            plan_type: isSaturated ? "daily_maintenance" : "fast_saturation",
            plan_name: nextPlanName,
            body_weight_kg: weightKg,
            duration_days: nextDurationDays,
            total_sachets: totalSachets,
            location: order.location,
            gym: order.gym,
            message: "Auto-renewed batch — awaiting delivery and payment confirmation.",
            gross_amount: grossAmount,
            discount_amount: discountAmount,
            net_amount: netAmount,
            total_kes: netAmount,
            discount_applied: discountApplied,
            is_milestone_reward: isMilestone,
            auto_renew: true,
            renewal_cancelled_at: null,
            renewed_at: null,
            confirmed_at: null,
            grams_delivered: gramsDelivered,
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

        results.push({
          phone: order.phone_number,
          previous_order: order.client_order_id,
          new_order: newOrderId,
          is_saturated: isSaturated,
          next_plan: nextPlanName,
          status: "created",
        });
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