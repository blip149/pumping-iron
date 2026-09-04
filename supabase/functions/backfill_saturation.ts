// backfill_saturation.ts
//
// ONE-OFF script. Run once, manually, before the new saturation-tracking
// system goes live. Not deployed as a permanent edge function.
//
// What it does:
//   For every client with a confirmed (delivered) or paid order, walks
//   their order history chronologically and simulates day-by-day how their
//   creatine store actually built up — spreading each order's grams evenly
//   across its consumption window (duration_days) rather than dumping them
//   all in on order date, and applying decay every single day, not just
//   between orders. Uses confirmed_at (delivery date) as the window start
//   when available, since consumption begins at delivery, not payment —
//   falls back to created_at for historical orders that predate that column.
//   Writes:
//     - orders.grams_delivered (per order, for future auditing)
//     - users.cumulative_grams_delivered (lifetime total — reporting only)
//     - users.store_grams_at_last_order (decay-adjusted store, as of now)
//     - users.store_reference_date (the "as of" date for that store value)
//     - users.saturation_reached_at (first date their store crossed
//       threshold, informational only — they can lapse and fall back below
//       it later, so this is never read as "currently saturated")
//
// Run with:
//   deno run --allow-net --allow-env backfill_saturation.ts
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (same values your edge functions already use).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in environment.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const db = supabase.schema("v2");

// Must match the WEIGHT_CLASSES table in index.ts at the time these
// historical orders were placed. If you changed the weight-class grams
// since launch, keep this snapshot as-is — it reflects what was ACTUALLY
// delivered historically, not today's rules.
const WEIGHT_CLASSES_SNAPSHOT: Record<string, number> = {
  A: 3.0,
  B: 4.5,
  C: 6.0,
  D: 7.5,
  E: 9.0,
};

const FLOOR_GRAMS = 3.0;

// Body clears roughly 1-2% of stored creatine per day, supplementing or not.
// 1.5% is the midpoint of that documented range — not a precise citation,
// a reasonable working estimate. This is why we can't just SUM lifetime
// grams delivered: a gap of weeks/months between orders means real decay
// happened, and the stored total needs to reflect that.
const DAILY_DECAY_RATE = 0.015;

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

// Simulates ONE order's consumption window day-by-day: decay happens every
// day, and the order's grams are spread evenly across its duration_days
// rather than dumped in on a single date. This matches how a client
// actually uses a batch of sachets — gradually, not all at once.
//
// Returns the store level at whichever comes first: the end of the order's
// window, or `simulateUpTo` (used for the most recent order, which may
// still be mid-consumption as of "now").
function simulateOrderWindow(args: {
  storeBefore: number;
  storeAsOfDate: Date;
  orderStart: Date;
  durationDays: number;
  totalGrams: number;
  threshold: number;
  simulateUpTo: Date;
}): { store: number; asOfDate: Date; crossedThresholdAt: Date | null; fullyConsumed: boolean } {
  const duration = Math.max(1, args.durationDays);
  const dailyDose = args.totalGrams / duration;
  const orderEnd = addDays(args.orderStart, duration);

  // Decay whatever existed before this order started, across any gap
  // between the previous reference point and this order's actual start.
  const gapDays = daysBetween(args.storeAsOfDate, args.orderStart);
  let store = gapDays > 0 ? decayStore(args.storeBefore, gapDays) : args.storeBefore;

  const simEnd = args.simulateUpTo < orderEnd ? args.simulateUpTo : orderEnd;
  const daysToSimulate = Math.max(0, Math.floor(daysBetween(args.orderStart, simEnd)));

  let crossedThresholdAt: Date | null = null;
  let cursor = args.orderStart;

  for (let day = 0; day < daysToSimulate; day++) {
    store = decayStore(store, 1) + dailyDose;
    cursor = addDays(cursor, 1);
    if (crossedThresholdAt === null && store >= args.threshold) {
      crossedThresholdAt = cursor;
    }
  }

  return { store, asOfDate: cursor, crossedThresholdAt, fullyConsumed: simEnd >= orderEnd };
}

function saturationThresholdGrams(weightKg: number): number {
  // T(W) = 84 * (W/70) — see /areas/pumping-iron.md for the derivation.
  return 84 * (weightKg / 70);
}

function weightClassLetter(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^Class\s*/i, "").trim().toUpperCase();
  return cleaned.length ? cleaned.slice(-1) : null;
}

function computeGramsForOrder(order: any): number {
  const wcLetter = weightClassLetter(order.weight_class);
  const wcGrams = wcLetter ? WEIGHT_CLASSES_SNAPSHOT[wcLetter] : null;

  if (order.plan_type === "fast_saturation") {
    // Historically: 20 sachets, all at weight-class grams.
    return (order.total_sachets ?? 20) * (wcGrams ?? FLOOR_GRAMS);
  }

  if (order.plan_type === "budget_optimized") {
    // budget_schedule was never actually deployed to this database (the
    // feature was scrapped before shipping) — fall back to the floor dose,
    // which is what these orders would have used in practice.
    return (order.total_sachets ?? 0) * FLOOR_GRAMS;
  }

  // daily_maintenance (and any legacy/unknown type): training days at
  // weight-class grams, rest days at the 3g floor.
  const trainingDays = order.training_sachet_days ?? 0;
  const restDays = order.rest_sachet_days ?? 0;
  if (trainingDays || restDays) {
    return trainingDays * (wcGrams ?? FLOOR_GRAMS) + restDays * FLOOR_GRAMS;
  }

  // Fallback for anything that doesn't match a known shape: assume floor dose.
  return (order.total_sachets ?? 0) * FLOOR_GRAMS;
}

async function run() {
  console.log("Fetching all confirmed/paid orders...");
  const { data: orders, error } = await db
    .from("orders")
    .select("id, phone_number, created_at, confirmed_at, duration_days, plan_type, total_sachets, weight_class, training_sachet_days, rest_sachet_days, status")
    .or("confirmed_at.not.is.null,status.eq.paid")
    .order("phone_number", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Fetch failed: ${error.message}`);
  if (!orders || orders.length === 0) {
    console.log("No confirmed or paid orders found. Nothing to backfill.");
    return;
  }

  console.log(`Processing ${orders.length} confirmed/paid orders across all clients...`);

  const byPhone = new Map<string, any[]>();
  for (const order of orders) {
    const list = byPhone.get(order.phone_number) ?? [];
    list.push(order);
    byPhone.set(order.phone_number, list);
  }

  let processedUsers = 0;
  let processedOrders = 0;
  const errors: Array<{ phone: string; error: string }> = [];

  for (const [phone, phoneOrders] of byPhone.entries()) {
    try {
      const { data: userRow, error: userError } = await db
        .from("users")
        .select("id, phone_number, body_weight_kg")
        .eq("phone_number", phone)
        .maybeSingle();

      if (userError) throw new Error(`User lookup failed: ${userError.message}`);
      if (!userRow) {
        errors.push({ phone, error: "No matching users row — skipped." });
        continue;
      }

      const weightKg = userRow.body_weight_kg ?? 70; // fallback to reference weight if missing
      const threshold = saturationThresholdGrams(weightKg);
      const now = new Date();

      // Lifetime total (business/reporting number — never used for saturation decisions)
      let lifetimeGrams = 0;

      // Decay-adjusted running store, walked forward through each order's
      // actual consumption window (not lump-summed on order date).
      let store = 0;
      let referenceDate: Date | null = null; // date `store` is valid as-of
      let firstCrossedThresholdAt: string | null = null;

      // Captured right BEFORE the last order is processed — this, not the
      // fully-simulated value, is what gets written as the operative
      // baseline. The live function (getCurrentSaturationStatus) finds the
      // most recent CONFIRMED order and simulates its own window itself —
      // if we wrote the fully-simulated value here too, that order's grams
      // would be counted twice the moment the live function ran.
      let preLastOrderBaseline = 0;
      let preLastOrderDate: Date | null = null;

      for (let i = 0; i < phoneOrders.length; i++) {
        const order = phoneOrders[i];
        const isLastOrder = i === phoneOrders.length - 1;

        if (isLastOrder) {
          preLastOrderBaseline = store;
          preLastOrderDate = referenceDate;
        }

        const grams = computeGramsForOrder(order);
        lifetimeGrams += grams;

        // Delivery date if known, otherwise fall back to payment date —
        // the best available proxy for orders that predate confirmed_at.
        const confirmedAt = order.confirmed_at ?? order.created_at;
        const orderStart = new Date(confirmedAt);
        const durationDays = order.duration_days ?? 1;

        const result = simulateOrderWindow({
          storeBefore: store,
          storeAsOfDate: referenceDate ?? orderStart,
          orderStart,
          durationDays,
          totalGrams: grams,
          threshold,
          // Only the LAST order might still be mid-consumption as of today;
          // earlier orders are assumed fully consumed by the time the next one started.
          simulateUpTo: isLastOrder ? now : addDays(orderStart, durationDays),
        });

        store = result.store;
        referenceDate = result.asOfDate;
        if (firstCrossedThresholdAt === null && result.crossedThresholdAt) {
          firstCrossedThresholdAt = result.crossedThresholdAt.toISOString();
        }

        // Stamp confirmed_at on every order (not just the last) so any
        // future "most recent confirmed order" lookup — for this client or
        // in reporting — always has a consistent anchor, even for orders
        // placed before this column existed.
        const { error: updateOrderError } = await db
          .from("orders")
          .update({ grams_delivered: round2(grams), confirmed_at: confirmedAt })
          .eq("id", order.id);
        if (updateOrderError) throw new Error(`Order update failed (${order.id}): ${updateOrderError.message}`);

        processedOrders++;
      }

      // If the last order's window fully ended before "now", decay the
      // remaining gap with no further additions (pure decay, closed-form).
      // This is INFO-ONLY (log output + saturation_reached_at) — not what
      // gets written as the operative baseline.
      const storeAsOfNow = referenceDate && referenceDate < now
        ? decayStore(store, daysBetween(referenceDate, now))
        : store;
      const currentlySaturated = storeAsOfNow >= threshold;

      const lastOrder = phoneOrders[phoneOrders.length - 1];
      const lastOrderStart = new Date(lastOrder.confirmed_at ?? lastOrder.created_at);

      const { error: updateUserError } = await db
        .from("users")
        .update({
          cumulative_grams_delivered: round2(lifetimeGrams),
          store_grams_at_last_order: round2(preLastOrderBaseline),
          store_reference_date: (preLastOrderDate ?? lastOrderStart).toISOString(),
          saturation_reached_at: firstCrossedThresholdAt,
        })
        .eq("id", userRow.id);

      if (updateUserError) throw new Error(`User update failed: ${updateUserError.message}`);

      processedUsers++;
      console.log(
        `${phone}: ${phoneOrders.length} orders, lifetime ${round2(lifetimeGrams)}g, ` +
        `store-as-of-now ${round2(storeAsOfNow)}g ` +
        `(threshold ${round2(threshold)}g), currently_saturated=${currentlySaturated} ` +
        `[baseline written: ${round2(preLastOrderBaseline)}g as of ${(preLastOrderDate ?? lastOrderStart).toISOString().slice(0,10)}]`
      );
    } catch (err) {
      errors.push({ phone, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log("\n--- Backfill complete ---");
  console.log(`Users updated: ${processedUsers}`);
  console.log(`Orders updated: ${processedOrders}`);
  if (errors.length) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) console.log(`  ${e.phone}: ${e.error}`);
  }
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

await run();