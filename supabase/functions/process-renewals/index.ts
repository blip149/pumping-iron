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
// Membership (VIP 10% + milestone bonus) comes from the same consecutive-order
// streak tracker as the checkout function: 4 consecutive orders earn it.
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
// Milestone orders take the normal VIP 10% and add bonus sachets worth this
// share of the discounted price (see the same constant in order-handler).
const MILESTONE_BONUS_RATE = 0.30;

const TUB_COST_KES = 3000;
const TUB_GRAMS = 410;
const PPG = TUB_COST_KES / TUB_GRAMS;
const MYLAR_SMALL = 1095 / 800;
const MYLAR_LARGE = 1095 / 400;
const BASE_PROFIT = 22;

// MEMBERSHIP STREAK TRACKER — keep these three constants and computeStreak()
// identical to order-handler. Membership is earned only by
// MEMBERSHIP_STREAK_ORDERS consecutive orders; an order counts once it is paid
// and picked up, and is consecutive when collected within STREAK_GRACE_DAYS of
// the previous batch ending. A later pickup restarts the streak at 1. Nobody
// is banned or blocked. Gaps that ended before STREAK_TRACKING_START are
// forgiven.
const MEMBERSHIP_STREAK_ORDERS = 4;
const STREAK_GRACE_DAYS = 3;
const STREAK_TRACKING_START = new Date("2026-10-15T00:00:00+03:00");

const FLAT_SACHET_GRAMS = 3.0;
const MAX_DOSES_PER_DAY = 3; // matches order-handler: checkout never sells more than 3x/day
// Clients at/over this weight are locked to 2x/day while saturating (same rule
// and same price as order-handler: the standard 2x/day formula). Once
// saturated they drop to the normal 1x/day maintenance batch.
const HEAVY_CLIENT_THRESHOLD_KG = 80;
const HEAVY_CLIENT_DOSES_PER_DAY = 2;
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

type DeliveredOrder = {
  confirmed_at: string;
  duration_days: number | null;
};

type StreakInfo = {
  streak: number;
  bestStreak: number;
  member: boolean;
  alive: boolean;
  lastWindowEnd: Date | null;
  pickupDeadline: Date | null;
};

// Identical to computeStreak in order-handler.
function computeStreak(orders: DeliveredOrder[], now: Date): StreakInfo {
  let streak = 0;
  let best = 0;
  let lastEnd: Date | null = null;

  for (const o of orders) {
    const start = new Date(o.confirmed_at);
    if (lastEnd === null) {
      streak = 1;
    } else {
      const from = lastEnd > STREAK_TRACKING_START ? lastEnd : STREAK_TRACKING_START;
      streak = start <= addDays(from, STREAK_GRACE_DAYS) ? streak + 1 : 1;
    }
    if (streak > best) best = streak;
    lastEnd = addDays(start, o.duration_days ?? 1);
  }

  if (lastEnd === null) {
    return { streak: 0, bestStreak: 0, member: false, alive: false, lastWindowEnd: null, pickupDeadline: null };
  }

  const deadline = addDays(lastEnd > STREAK_TRACKING_START ? lastEnd : STREAK_TRACKING_START, STREAK_GRACE_DAYS);
  const alive = now <= deadline;
  return {
    streak: alive ? streak : 0,
    bestStreak: best,
    member: best >= MEMBERSHIP_STREAK_ORDERS,
    alive,
    lastWindowEnd: lastEnd,
    pickupDeadline: alive ? deadline : null,
  };
}

// Paid AND picked-up orders only, same as the checkout's eligibility lookup.
async function getMembership(phone: string, now: Date): Promise<{ isVip: boolean; completedCount: number }> {
  const { data, error } = await db
    .from("orders")
    .select("confirmed_at, duration_days")
    .eq("phone_number", phone)
    .eq("status", "paid")
    .not("confirmed_at", "is", null)
    .order("confirmed_at", { ascending: true });
  if (error) throw new Error(`Membership lookup failed: ${error.message}`);

  const orders = data ?? [];
  return { isVip: computeStreak(orders, now).member, completedCount: orders.length };
}

// Days of dosing at `dosesPerDay` sachets a day until the store reaches the
// threshold, with the same daily decay as simulateOrderWindow (and identical
// to order-handler's daysToSaturate). null = that pace can never get there.
const MAX_SATURATION_DAYS = 120;

function daysToSaturate(currentStoreGrams: number, thresholdGrams: number, dosesPerDay: number): number | null {
  let store = currentStoreGrams;
  const dose = dosesPerDay * FLAT_SACHET_GRAMS;
  for (let day = 1; day <= MAX_SATURATION_DAYS; day++) {
    store = Math.min(thresholdGrams, decayStore(store, 1) + dose);
    if (store >= thresholdGrams) return day;
  }
  return null;
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
      .not("confirmed_at", "is", null) // the due date counts from real pickup
      .eq("auto_renew", true)
      .is("renewal_cancelled_at", null)
      .is("renewed_at", null);

    if (fetchError) throw new Error(`Fetch failed: ${fetchError.message}`);

    const results: Array<Record<string, unknown>> = [];

    for (const order of dueCandidates || []) {
      const durationDays = order.duration_days ?? 1;
      // confirmed_at is the real pickup date (candidates are delivered only,
      // so a paid-but-not-yet-delivered order can't renew early).
      const orderStart = new Date(order.confirmed_at);
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
        const membership = await getMembership(order.phone_number, now);
        const isVip = membership.isVip;
        // Milestone on a member's 8th, 12th, 16th order and so on.
        const isMilestone = isVip && (membership.completedCount + 1) % 4 === 0;

        let nextDosesPerDay: number;
        let nextDurationDays: number;
        let nextPlanName: string;

        if (isSaturated) {
          nextDosesPerDay = 1;
          nextDurationDays = MAINTENANCE_BATCH_DAYS;
          nextPlanName = "Maintenance (1x/day)";
        } else {
          // Same pace the client originally chose for this batch, except
          // heavy clients, who are always held to the locked 2x/day.
          const previousDosesPerDay = Math.max(1, Math.round((order.total_sachets ?? 0) / durationDays));
          nextDosesPerDay = weightKg >= HEAVY_CLIENT_THRESHOLD_KG
            ? HEAVY_CLIENT_DOSES_PER_DAY
            : Math.min(MAX_DOSES_PER_DAY, previousDosesPerDay);

          // Decay-aware: same day-by-day model the live saturation status uses.
          const daysStillNeeded = daysToSaturate(currentStore, threshold, nextDosesPerDay) ?? WEEKLY_BATCH_DAYS;

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
        if (isVip || isMilestone) { discountRate = MEMBER_DISCOUNT_RATE; discountApplied = "VIP_10"; }

        const discountAmount = round2(grossAmount * discountRate);
        const netAmount = round2(grossAmount - discountAmount);

        // Bonus sachets sit outside total_sachets so the next batch's
        // doses-per-day math (total_sachets / duration_days) stays correct.
        const bonusSachets = isMilestone
          ? Math.floor(totalSachets * MILESTONE_BONUS_RATE + 1e-9)
          : 0;

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
            bonus_sachets: bonusSachets,
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