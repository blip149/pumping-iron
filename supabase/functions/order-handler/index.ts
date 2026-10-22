import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment configuration.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const db = supabase.schema("v2");

// Gates the admin-only order-listing endpoint (used by admin.html) — not
// meant for public/client traffic. Set via `supabase secrets set`.
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";

const PHONE_REGEX = /^\+254[17]\d{8}$/;
const IRONCLAD_TIER = "ironclad_vip";
const LEAD_TIER = "lead";

const MEMBER_DISCOUNT_RATE = 0.10;
// Milestone (the 8th, 12th, 16th order and so on) is no longer a bigger price cut. The order
// gets the normal 10% VIP discount, and then bonus sachets worth this share
// of the DISCOUNTED price are added on top. Bonus sachets are valued at the
// order's own net per-sachet price, so the count is simply this share of the
// order's sachets. They are stored separately (bonus_sachets) and never added
// to total_sachets, so dosing and renewal math stay correct.
const MILESTONE_BONUS_RATE = 0.30;
const REFERRAL_DISCOUNT_RATE = 0.15; // referred client's first order — tune freely

// Admin/marketing referral codes — pre-issued for tracking a promotional
// channel (a gym visit, an influencer post, a printed sticker QR) rather
// than a real client's phone number. These deliberately bypass the
// "referrer must be an existing client with a paid/confirmed order" check
// below, since there's no real client behind the code to check — add new
// codes here as new channels launch. Matched case-insensitively so "pm003"
// and "PM003" are the same code.
const ADMIN_REFERRAL_CODES = new Set(["PM001", "PM002", "PM003"]);

// MEMBERSHIP STREAK TRACKER. Ironclad membership is earned only by
// MEMBERSHIP_STREAK_ORDERS (4) CONSECUTIVE orders. An order counts once it is
// both paid and picked up (delivery confirmed). It is consecutive when the
// client collects it within STREAK_GRACE_DAYS of the previous batch running
// out (batch end = confirmed pickup date + duration_days). A later pickup
// simply restarts the streak at 1: nothing else happens to the client, there
// is no ban and no blocking. Once earned, membership is kept for good. Gaps
// that ended before STREAK_TRACKING_START are forgiven so existing clients
// aren't judged retroactively. Keep these constants and computeStreak()
// identical in process-renewals.
const MEMBERSHIP_STREAK_ORDERS = 4;
const STREAK_GRACE_DAYS = 3;
const STREAK_TRACKING_START = new Date("2026-10-15T00:00:00+03:00");
const NUDGE_LEAD_DAYS = 1; // admin nudge list: batches ending within a day
// Order size limits. The floor matches the renewal tail-batch floor, so a
// 2-sachet order can never be placed.
const MIN_ORDER_DAYS = 6;
const MAX_ORDER_DAYS = 90;

const TUB_COST_KES = 3000;
const TUB_GRAMS = 410;
const PPG = TUB_COST_KES / TUB_GRAMS;
const MYLAR_SMALL = 1095 / 800;
const MYLAR_LARGE = 1095 / 400;
const BASE_PROFIT = 22;

// Weight is used ONLY to compute each client's personal saturation
// threshold (see saturationThresholdGrams below) — it no longer determines
// dose size or price. There is one product: a flat 3g sachet.
const MIN_WEIGHT_KG = 30;
const MAX_WEIGHT_KG = 250;

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundUpKES(value: number): number {
  return Math.ceil(value - Number.EPSILON);
}

function normalizePhone(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function getMylarCost(grams: number): number {
  return grams <= 4.5 ? MYLAR_SMALL : MYLAR_LARGE;
}

function getSachetCost(grams: number): number {
  return round2(PPG * grams + getMylarCost(grams));
}

function getSachetPrice(grams: number): number {
  return roundUpKES(getSachetCost(grams) + BASE_PROFIT);
}

function validatePayload(body: any, requireClientOrderId = true): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Invalid JSON payload.";
  }

  if (requireClientOrderId) {
    if (typeof body.client_order_id !== "string" || !body.client_order_id.trim()) {
      return "client_order_id is required.";
    }
  }

  const phone = normalizePhone(body.phone_number);
  if (!PHONE_REGEX.test(phone)) {
    return "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX.";
  }

  const weight = Number(body.body_weight_kg);
  if (!Number.isFinite(weight) || weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) {
    return `body_weight_kg must be between ${MIN_WEIGHT_KG} and ${MAX_WEIGHT_KG} kg.`;
  }

  // doses_per_day only matters for a NOT-yet-saturated client choosing a
  // saturation-speed tier — validated against the live-generated menu
  // server-side once we know their actual saturation status, not here.
  if (body.doses_per_day != null) {
    const doses = Number(body.doses_per_day);
    if (!Number.isInteger(doses) || doses < 1 || doses > MAX_DOSES_PER_DAY) {
      return `doses_per_day must be an integer from 1 to ${MAX_DOSES_PER_DAY}.`;
    }
  }

  return null;
}

async function getOrCreateUser(profile: {
  phone: string;
  weight: number;
  location: string;
  gym: string;
}) {
  const { data: existing, error: lookupError } = await db
    .from("users")
    .select("id")
    .eq("phone_number", profile.phone)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`User lookup failed: ${lookupError.message}`);
  }

  const profileData = {
    body_weight_kg: profile.weight,
    location: profile.location || null,
    preferred_gym: profile.gym || null,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await db
      .from("users")
      .update(profileData)
      .eq("id", existing.id);

    if (error) {
      throw new Error(`User update failed: ${error.message}`);
    }

    return existing.id;
  }

  const { data: created, error: insertError } = await db
    .from("users")
    .insert({
      phone_number: profile.phone,
      ...profileData,
    })
    .select("id")
    .single();

  if (!insertError && created?.id) {
    return created.id;
  }

  const { data: retry, error: retryError } = await db
    .from("users")
    .select("id")
    .eq("phone_number", profile.phone)
    .maybeSingle();

  if (retryError || !retry?.id) {
    throw new Error(`User creation failed: ${insertError?.message ?? "unknown error"}`);
  }

  return retry.id;
}

// ----------------------------------------------------------
// MEMBERSHIP STREAK TRACKER
//
// computeStreak replays a client's paid-and-picked-up orders in pickup order.
// The first order starts a streak of 1. Every later order extends it if it
// was collected by the previous batch's end + STREAK_GRACE_DAYS (never
// counting time before STREAK_TRACKING_START), otherwise the streak restarts
// at 1. Membership is earned the moment any streak reaches
// MEMBERSHIP_STREAK_ORDERS and is then kept.
// ----------------------------------------------------------
type DeliveredOrder = {
  confirmed_at: string;
  duration_days: number | null;
};

type StreakInfo = {
  streak: number; // consecutive orders right now (0 once the streak has lapsed)
  bestStreak: number;
  member: boolean;
  alive: boolean;
  lastWindowEnd: Date | null;
  pickupDeadline: Date | null; // collect the next batch by this to keep the streak
};

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

async function getIroncladEligibility(phone: string) {
  const { count: totalPaid, error: totalError } = await db
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("phone_number", phone)
    .eq("status", "paid");
  if (totalError) throw new Error(`Failed to count orders: ${totalError.message}`);

  const { data: qualifying, error: qualifyingError } = await db
    .from("orders")
    .select("confirmed_at, duration_days")
    .eq("phone_number", phone)
    .eq("status", "paid")
    .not("confirmed_at", "is", null)
    .order("confirmed_at", { ascending: true });
  if (qualifyingError) throw new Error(`Failed to load orders: ${qualifyingError.message}`);

  const orders = qualifying ?? [];
  const streakInfo = computeStreak(orders, new Date());
  const completedCount = orders.length; // paid AND picked up
  const isVip = streakInfo.member;
  // Milestone on a member's 8th, 12th, 16th order and so on.
  const isMilestone = isVip && (completedCount + 1) % 4 === 0;

  return { paidCount: totalPaid || 0, completedCount, isVip, isMilestone, streakInfo };
}

async function isPaidOrConfirmedClient(phone: string): Promise<boolean> {
  // Check if candidate referrer has at least 1 paid order
  const { count: paidCount, error: paidError } = await db
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("phone_number", phone)
    .eq("status", "paid");

  if (!paidError && (paidCount ?? 0) > 0) return true;

  // Or at least 1 order with confirmed delivery
  const { count: confirmedCount, error: confirmedError } = await db
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("phone_number", phone)
    .not("confirmed_at", "is", null);

  if (!confirmedError && (confirmedCount ?? 0) > 0) return true;

  return false;
}

// Shared by both the quote preview and the real order, so a fraudulent
// referral can never slip through one path just because the checks only
// lived in the other. Every rule here exists to eliminate a specific fake:
//   - phone format enforced           -> can't submit garbage/placeholder
//   - self-referral blocked           -> can't refer your own new number
//   - referrer must be a real client  -> can't invent a fake referrer
//   - caller only calls this when isFirstOrderEver -> can't reuse a used-up
//     phone number's "new client" discount on a later order
async function validateReferral(
  phone: string,
  referredByRaw: unknown,
): Promise<{ ok: true; referredByPhone: string | null } | { ok: false; error: string }> {
  if (typeof referredByRaw !== "string" || !referredByRaw.trim()) {
    return { ok: true, referredByPhone: null };
  }

  // Admin/marketing codes short-circuit everything below — they're not a
  // claim about being an existing client, so there's no order history or
  // self-referral check that applies to them.
  const upperCode = referredByRaw.trim().toUpperCase();
  if (ADMIN_REFERRAL_CODES.has(upperCode)) {
    return { ok: true, referredByPhone: upperCode };
  }

  const candidateReferrer = normalizePhone(referredByRaw);
  if (!candidateReferrer || !PHONE_REGEX.test(candidateReferrer)) {
    return { ok: false, error: "Invalid referred_by_phone format." };
  }
  if (candidateReferrer === phone) {
    return { ok: false, error: "You cannot refer yourself." };
  }

  const isEligible = await isPaidOrConfirmedClient(candidateReferrer);
  if (!isEligible) {
    return {
      ok: false,
      error: "The referred-by number must belong to an existing client with at least 1 paid or confirmed order.",
    };
  }

  return { ok: true, referredByPhone: candidateReferrer };
}

// ----------------------------------------------------------
// LIVE SATURATION STATUS
//
// Same decay model used in backfill_saturation.ts, but computed fresh
// against RIGHT NOW instead of a frozen historical run. This is what
// answers "where does this client's store actually stand today" for the
// checkout flow, the streak lookup, and future dosing recommendations.
//
// Personalized in two places:
//   - threshold(weight) — how much store this specific person needs
//   - store_grams_at_last_order — this specific person's own last snapshot
// The decay RATE itself (1.5%/day) is a fixed biological turnover
// constant, not weight-dependent — it's applied to whatever store this
// person actually has, which already scales the absolute grams/day lost.
// ----------------------------------------------------------
const DAILY_DECAY_RATE = 0.015;

function saturationThresholdGrams(weightKg: number): number {
  // T(W) = 84 * (W/70) — 84g calibrated to the 3g/day x 28 day literature
  // anchor at the ~70kg reference weight most studies use.
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

// Simulates ONE order's consumption window day-by-day: decay happens every
// day, and the order's grams are spread evenly across duration_days rather
// than dumped in on a single date — matches gradual real-world consumption.
// Mirrors backfill_saturation.ts exactly, so historical and live numbers
// are computed the same way.
function simulateOrderWindow(args: {
  storeBefore: number;
  storeAsOfDate: Date;
  orderStart: Date;
  durationDays: number;
  totalGrams: number;
  threshold: number;
  simulateUpTo: Date;
}): { store: number; asOfDate: Date; crossedThresholdAt: Date | null } {
  const duration = Math.max(1, args.durationDays);
  const dailyDose = args.totalGrams / duration;
  const orderEnd = addDays(args.orderStart, duration);

  const gapDays = daysBetween(args.storeAsOfDate, args.orderStart);
  let store = gapDays > 0 ? decayStore(args.storeBefore, gapDays) : args.storeBefore;

  // Doses only happen during the order's own window — cap the DOSING
  // simulation at orderEnd even if simulateUpTo is later.
  const doseEnd = args.simulateUpTo < orderEnd ? args.simulateUpTo : orderEnd;
  const daysToSimulate = Math.max(0, Math.floor(daysBetween(args.orderStart, doseEnd)));

  let crossedThresholdAt: Date | null = null;
  let cursor = args.orderStart;

  for (let day = 0; day < daysToSimulate; day++) {
    // Once at the ceiling, extra doses don't accumulate — they're excreted,
    // essentially immediately, since muscle uptake is already maxed out.
    store = Math.min(args.threshold, decayStore(store, 1) + dailyDose);
    cursor = addDays(cursor, 1);
    if (crossedThresholdAt === null && store >= args.threshold) {
      crossedThresholdAt = cursor;
    }
  }

  // If we're being asked about a moment AFTER the order's window ended
  // (e.g. checking status weeks after their last batch ran out), keep
  // decaying — no more doses, but the store doesn't just freeze in place.
  if (args.simulateUpTo > orderEnd) {
    const extraDays = daysBetween(orderEnd, args.simulateUpTo);
    store = decayStore(store, extraDays);
    cursor = args.simulateUpTo;
  }

  return { store, asOfDate: cursor, crossedThresholdAt };
}

// ----------------------------------------------------------
// Data model contract (kept in sync with confirm_delivery, below):
//   users.store_grams_at_last_order + store_reference_date = the store
//   level at the moment the client's MOST RECENTLY CONFIRMED order
//   STARTED (i.e., fully accounts for every order before that one, but
//   not that order's own doses yet). confirm_delivery is the only thing
//   that writes these two fields.
//
//   To get the LIVE current store, we take that baseline and simulate
//   forward through the most recent confirmed order's own window, up to
//   right now — handling both "still mid-batch" and "batch fully used,
//   now just decaying" cases via simulateOrderWindow's simulateUpTo cap.
// ----------------------------------------------------------
async function getCurrentSaturationStatus(phone: string, weightOverrideKg?: number) {
  const { data: userRow, error: userError } = await db
    .from("users")
    .select("body_weight_kg, store_grams_at_last_order, store_reference_date")
    .eq("phone_number", phone)
    .maybeSingle();

  if (userError) throw new Error(`User lookup failed: ${userError.message}`);

  const now = new Date();
  // Always prefer the weight just submitted in this request — a client's
  // weight can change, and a brand-new client has no stored weight at all.
  // Falling back to the DB value (then 70kg) only covers calls with no
  // fresher weight available.
  const weightKg = weightOverrideKg ?? userRow?.body_weight_kg ?? 70;
  const threshold = saturationThresholdGrams(weightKg);

  if (!userRow) {
    return {
      isNewClient: true,
      asOfDate: now.toISOString(),
      lastConfirmedOrderDate: null,
      thresholdGrams: round2(threshold),
      currentStoreGrams: 0,
      percentSaturated: 0,
      isSaturated: false,
    };
  }

  const { data: currentOrder, error: orderError } = await db
    .from("orders")
    .select("confirmed_at, duration_days, grams_delivered")
    .eq("phone_number", phone)
    .not("confirmed_at", "is", null)
    .order("confirmed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (orderError) throw new Error(`Order lookup failed: ${orderError.message}`);

  if (!currentOrder) {
    return {
      isNewClient: true,
      asOfDate: now.toISOString(),
      lastConfirmedOrderDate: null,
      thresholdGrams: round2(threshold),
      currentStoreGrams: 0,
      percentSaturated: 0,
      isSaturated: false,
    };
  }

  const baseline = userRow.store_grams_at_last_order ?? 0;
  const baselineDate = userRow.store_reference_date ? new Date(userRow.store_reference_date) : new Date(currentOrder.confirmed_at);
  const orderStart = new Date(currentOrder.confirmed_at);
  const durationDays = currentOrder.duration_days ?? 1;
  const grams = currentOrder.grams_delivered ?? 0;

  const result = simulateOrderWindow({
    storeBefore: baseline,
    storeAsOfDate: baselineDate,
    orderStart,
    durationDays,
    totalGrams: grams,
    threshold,
    simulateUpTo: now,
  });

  const percentSaturated = Math.min(100, round2((result.store / threshold) * 100));

  return {
    isNewClient: false,
    asOfDate: now.toISOString(),
    lastConfirmedOrderDate: currentOrder.confirmed_at,
    thresholdGrams: round2(threshold),
    currentStoreGrams: round2(result.store),
    percentSaturated,
    isSaturated: result.store >= threshold,
  };
}

// Nairobi is UTC+3 all year (no DST). YYYY-MM-DD string for a moment in time.
function nairobiDateStr(d: Date): string {
  return new Date(d.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Adds credits to a client's balance without ever overwriting a concurrent
// change: the update only lands if the balance is still what we just read.
async function addReferralCredits(userId: string, amount: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: row, error } = await db
      .from("users")
      .select("referral_credits")
      .eq("id", userId)
      .maybeSingle();
    if (error || !row) return false;

    const raw = row.referral_credits;
    let q = db.from("users").update({ referral_credits: (raw ?? 0) + amount }).eq("id", userId);
    q = raw === null || raw === undefined ? q.is("referral_credits", null) : q.eq("referral_credits", raw);
    const { data: updated, error: updateError } = await q.select("id");
    if (updateError) return false;
    if (updated && updated.length > 0) return true;
  }
  return false;
}

// ----------------------------------------------------------
// confirm_delivery — marks an order as physically delivered (which can
// happen before payment lands) and establishes the store baseline this
// order's own consumption window will build from.
//
// Important: this does NOT add the order's grams immediately. It only
// decays the client's existing baseline forward to right now (the moment
// delivery happened) and records that as the new reference point. The
// order's own doses accrue lazily, day by day, whenever
// getCurrentSaturationStatus is next called for this client — it looks up
// this same order (by confirmed_at) and simulates forward from here.
// ----------------------------------------------------------
async function confirmDelivery(clientOrderId: string, pickupDateOverride?: string) {
  const { data: order, error: orderError } = await db
    .from("orders")
    .select("id, phone_number, created_at, confirmed_at, grams_delivered, duration_days, body_weight_kg")
    .eq("client_order_id", clientOrderId)
    .maybeSingle();

  if (orderError) throw new Error(`Order lookup failed: ${orderError.message}`);
  if (!order) return { confirmed: false, reason: "Order not found." };
  if (order.confirmed_at) {
    return { confirmed: false, reason: "Order was already confirmed.", confirmedAt: order.confirmed_at };
  }

  const actualNow = new Date();
  let now = actualNow;

  if (pickupDateOverride) {
    // The admin page sends a plain YYYY-MM-DD. Compare calendar days in
    // Nairobi time (UTC+3) rather than timestamps, otherwise "today" parses
    // as midnight UTC and fails the "before the order was placed" check for
    // any order placed the same day.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDateOverride) || Number.isNaN(new Date(`${pickupDateOverride}T12:00:00+03:00`).getTime())) {
      return { confirmed: false, reason: "pickup_date is not a valid date." };
    }
    const today = nairobiDateStr(actualNow);
    const placed = nairobiDateStr(new Date(order.created_at));
    if (pickupDateOverride > today) {
      return { confirmed: false, reason: "pickup_date can't be in the future." };
    }
    if (pickupDateOverride < placed) {
      return { confirmed: false, reason: "pickup_date can't be before the order was placed." };
    }
    if (pickupDateOverride < today) {
      const noon = new Date(`${pickupDateOverride}T12:00:00+03:00`);
      const created = new Date(order.created_at);
      now = noon > created ? noon : created;
    }
  }

  const { data: userRow, error: userError } = await db
    .from("users")
    .select("id, store_grams_at_last_order, store_reference_date, cumulative_grams_delivered")
    .eq("phone_number", order.phone_number)
    .maybeSingle();

  if (userError) throw new Error(`User lookup failed: ${userError.message}`);
  if (!userRow) throw new Error(`No users row found for phone ${order.phone_number}.`);

  const priorBaseline = userRow.store_grams_at_last_order ?? 0;
  const priorReferenceDate = userRow.store_reference_date ? new Date(userRow.store_reference_date) : now;
  const gapDays = daysBetween(priorReferenceDate, now);
  const newBaseline = gapDays > 0 ? decayStore(priorBaseline, gapDays) : priorBaseline;

  // Claim the order atomically so a double click (or two admin tabs) can't
  // confirm it twice and award the referral credit twice.
  const { data: claimed, error: updateOrderError } = await db
    .from("orders")
    .update({ confirmed_at: now.toISOString() })
    .eq("id", order.id)
    .is("confirmed_at", null)
    .select("id");
  if (updateOrderError) throw new Error(`Order update failed: ${updateOrderError.message}`);
  if (!claimed || claimed.length === 0) {
    return { confirmed: false, reason: "Order was already confirmed." };
  }

  const { error: updateUserError } = await db
    .from("users")
    .update({
      store_grams_at_last_order: round2(newBaseline),
      store_reference_date: now.toISOString(),
      cumulative_grams_delivered: round2((userRow.cumulative_grams_delivered ?? 0) + (order.grams_delivered ?? 0)),
    })
    .eq("id", userRow.id);
  if (updateUserError) throw new Error(`User update failed: ${updateUserError.message}`);

  // Referral credit: fires on ANY confirmed order for this client — including
  // their first — as long as their first order carries referred_by_phone
  // (only the first order ever carries it). Only once per order (guarded by
  // the confirmed_at check above — this function never runs twice on one
  // order). Starting from order 1 matters because a fast-saturation client
  // can reach threshold on their very first order; if credit only started on
  // renewals, a referrer of that client would never be credited at all,
  // since the reward window (below) would already be closed by the time any
  // renewal came around. The referred client's own first-order discount was
  // scaled down from 20% to 15% to fund this.
  //
  // Reward window: credit stops once the referred client was ALREADY
  // saturated — i.e. had already "become a member" — BEFORE this order
  // started. `newBaseline` above is exactly the referred client's store
  // level at the moment this order begins, decayed forward but not yet
  // counting this order's own doses, so it's the right check (for a brand
  // new client on their first order, this is always 0, so the first order
  // always passes). If they crossed into saturation during an earlier
  // confirmed order, this later order earns no credit. If they were still
  // unsaturated when THIS order started, the referrer gets full credit for
  // this order's entire duration even if this order's own dosing pushes
  // them into saturation partway through — a single order's reward is
  // never prorated mid-order, only the boundary between orders is checked.
  //
  // Credit scales with order length: 1 sachet per week of this order's
  // duration_days (rounded to the nearest whole sachet, minimum 1), so the
  // referrer earns proportionally the same share of the order regardless
  // of whether it's a 1-week or 4-week package.
  let referralCredited = false;
  const { data: firstOrder, error: firstOrderError } = await db
    .from("orders")
    .select("id, referred_by_phone")
    .eq("phone_number", order.phone_number)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!firstOrderError && firstOrder && firstOrder.referred_by_phone) {
    const referredWeightKg = order.body_weight_kg ?? userRow.body_weight_kg ?? 70;
    const referredThreshold = saturationThresholdGrams(referredWeightKg);
    const wasAlreadySaturatedBeforeThisOrder = newBaseline >= referredThreshold;

    if (!wasAlreadySaturatedBeforeThisOrder) {
      const referrerPhone = firstOrder.referred_by_phone;
      const { data: referrerRow, error: referrerError } = await db
        .from("users")
        .select("id")
        .eq("phone_number", referrerPhone)
        .maybeSingle();

      if (!referrerError && referrerRow) {
        const durationDays = order.duration_days ?? 1;
        const creditSachets = Math.max(1, Math.round(durationDays / 7));

        if (await addReferralCredits(referrerRow.id, creditSachets)) {
          await db
            .from("orders")
            .update({ referral_credit_awarded: true, referral_credit_amount: creditSachets })
            .eq("id", order.id);
          referralCredited = true;
        }
      }
    }
  }

  return {
    confirmed: true,
    confirmedAt: now.toISOString(),
    baselineStoreGrams: round2(newBaseline),
    referralCredited,
  };
}

// ----------------------------------------------------------
// PRICING & TIER ENGINE
//
// One product only: a 3g sachet. Personalization lives entirely in
// FREQUENCY (doses/day) and TIMELINE (days to saturate), computed fresh
// per client from their weight and live saturation status — never in
// dose size. See /areas/pumping-iron.md for the full derivation.
// ----------------------------------------------------------
const FLAT_SACHET_GRAMS = 3.0;
const FLAT_SACHET_PRICE = getSachetPrice(FLAT_SACHET_GRAMS); // ~46 KES
const MAX_DOSES_PER_DAY = 3; // no rush to saturate — don't overwhelm the body with high-frequency dosing
const MAINTENANCE_BATCH_DAYS = 14;
const WEEKLY_BATCH_DAYS = 7; // the floor for an auto-sized (no duration picked) order

// Clients at/over this weight are locked to 2x/day while saturating (no tier
// choice) because their larger store would take too long at 1x/day. Pricing
// is the SAME math as everyone's 2x plan (dailyCostForDoses(2)), and once
// saturated, or past their natural saturation days, they drop to the normal
// 1x/day maintenance bucket exactly like other clients.
const HEAVY_CLIENT_THRESHOLD_KG = 80;
const HEAVY_CLIENT_DOSES_PER_DAY = 2;

// price(n) = 46 - 9*(n-1)/n — approaches but can never reach/exceed a
// 9 KES/sachet discount, at any dose frequency, by construction.
function priceForNthDose(n: number): number {
  return round2(FLAT_SACHET_PRICE - 9 * ((n - 1) / n));
}

function dailyCostForDoses(dosesPerDay: number): number {
  let total = 0;
  for (let n = 1; n <= dosesPerDay; n++) total += priceForNthDose(n);
  return round2(total);
}

// Days of dosing at `dosesPerDay` sachets a day until the store reaches the
// threshold. Uses the same day-by-day decay as simulateOrderWindow, so a
// quoted "ready in ~N days" matches what the live saturation status will
// actually show. Returns null if that pace can never get there.
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

// Menu for a NOT-YET-saturated client: every doses/day option that can reach
// their personal saturation level. No dilution — every dose is a full 3g
// sachet; only frequency changes.
function generateSaturationTierMenu(currentStoreGrams: number, thresholdGrams: number) {
  const tiers: Array<{
    dosesPerDay: number;
    daysToSaturate: number;
    dailyCost: number;
    totalCost: number;
    totalSachets: number;
  }> = [];

  for (let n = 1; n <= MAX_DOSES_PER_DAY; n++) {
    const days = daysToSaturate(currentStoreGrams, thresholdGrams, n);
    if (days === null) continue; // e.g. 1x/day can't fill a very large store
    const dailyCost = dailyCostForDoses(n);
    tiers.push({
      dosesPerDay: n,
      daysToSaturate: days,
      dailyCost,
      totalCost: round2(dailyCost * days),
      totalSachets: n * days,
    });
  }

  return tiers;
}

function calculateOrderFinancials(args: {
  isSaturated: boolean;
  currentStoreGrams: number;
  thresholdGrams: number;
  bodyWeightKg: number;
  requestedDosesPerDay?: number;
  requestedDurationDays?: number;
  isVip: boolean;
  isMilestone: boolean;
  isReferredFirstOrder?: boolean;
}) {
  let dosesPerDay: number;
  let durationDays: number;
  let naturalDurationDays: number | null = null;
  // The split that actually drives pricing/dosing below: saturationDays get
  // dosed at `dosesPerDay` (at the normal formula), maintenanceDays always get dosed at flat 1/day. A
  // client-selected duration never changes naturalDurationDays (the
  // science) — it only decides how much of THIS order's total falls on
  // each side of that number.
  let saturationDays = 0;
  let maintenanceDays = 0;

  if (args.isSaturated) {
    // Maintenance: fixed dose, no speed tiers — more than 1/day does
    // nothing extra once saturated, so we never sell it. Already a pure
    // maintenance purchase, so a client-selected duration is honored
    // outright — nothing to blend.
    dosesPerDay = 1;
    durationDays = args.requestedDurationDays ?? MAINTENANCE_BATCH_DAYS;
    maintenanceDays = durationDays;
  } else {
    const menu = generateSaturationTierMenu(args.currentStoreGrams, args.thresholdGrams);
    const wanted = args.bodyWeightKg >= HEAVY_CLIENT_THRESHOLD_KG
      ? HEAVY_CLIENT_DOSES_PER_DAY
      : args.requestedDosesPerDay;
    const chosen = menu.find((t) => t.dosesPerDay === wanted) ?? menu[0];
    if (!chosen) {
      throw new Error("No valid saturation tier available for this weight.");
    }
    dosesPerDay = chosen.dosesPerDay;
    naturalDurationDays = chosen.daysToSaturate;

    if (args.requestedDurationDays != null) {
      // Client picked the total length themselves — e.g. stocking up to
      // 30 days to make the most of a milestone discount, or choosing a
      // shorter first purchase instead of committing to the full natural
      // need up front. The natural days-to-saturate is still computed
      // above, untouched, and reported back alongside this. Anything
      // beyond it is priced and dosed as maintenance rather than
      // continuing the saturation frequency — continuing the higher dose
      // past the point of saturation would just be waste, the same
      // reasoning that already governs the maintenance branch above.
      durationDays = args.requestedDurationDays;
    } else {
      // No duration picked — auto-size to the natural need, floored at a
      // full week so we never sell just the bare number of days needed to
      // top off. If a client wants a smaller first purchase than that,
      // the duration dropdown is how they ask for it directly.
      durationDays = Math.max(WEEKLY_BATCH_DAYS, chosen.daysToSaturate);
    }
    saturationDays = Math.min(durationDays, chosen.daysToSaturate);
    maintenanceDays = Math.max(0, durationDays - chosen.daysToSaturate);
  }

  const totalSachets = (dosesPerDay * saturationDays) + (1 * maintenanceDays);
  const gramsDelivered = round2(totalSachets * FLAT_SACHET_GRAMS);
  const saturationDailyCost = dailyCostForDoses(dosesPerDay);
  const grossAmount = round2(
    (saturationDailyCost * saturationDays) + (dailyCostForDoses(1) * maintenanceDays)
  );

  let discountRate = 0;
  let discountApplied = "NONE";
  // A milestone order is always a VIP order (4+ prior paid orders), so it
  // takes the VIP 10% like any other and earns bonus sachets on top (below).
  if (args.isVip || args.isMilestone) {
    discountRate = MEMBER_DISCOUNT_RATE;
    discountApplied = "VIP_10";
  } else if (args.isReferredFirstOrder) {
    // Can only ever be true alongside isVip/isMilestone being false — both
    // of those require 4+ prior paid orders, and this only fires on a
    // client's very first order ever (enforced by the caller). Written as
    // its own branch anyway so that invariant isn't load-bearing here.
    discountRate = REFERRAL_DISCOUNT_RATE;
    discountApplied = "REFERRAL_15";
  }

  const discountAmount = round2(grossAmount * discountRate);
  const netAmount = round2(grossAmount - discountAmount);

  // Milestone bonus: sachets worth MILESTONE_BONUS_RATE of the already
  // discounted price. At the order's net per-sachet price that is exactly
  // MILESTONE_BONUS_RATE of its sachets, rounded down so the giveaway never
  // overshoots the stated share. Not part of totalSachets / gramsDelivered.
  const bonusSachets = args.isMilestone
    ? Math.floor(totalSachets * MILESTONE_BONUS_RATE + 1e-9)
    : 0;
  const bonusValueKes = totalSachets > 0
    ? round2(bonusSachets * (netAmount / totalSachets))
    : 0;

  return {
    dosesPerDay,
    durationDays,
    maintenanceDays,
    totalSachets,
    gramsDelivered,
    grossAmount,
    discountAmount,
    netAmount,
    discountApplied,
    discountRate,
    naturalDurationDays,
    bonusSachets,
    bonusValueKes,
  };
}

// ----------------------------------------------------------
// confirm_payment — marks an order's PAYMENT as received. Deliberately
// independent from confirm_delivery above: an order can be delivered before
// it's paid (cash/M-Pesa collected on a later visit) or paid before it's
// delivered, depending on how a given order actually plays out. This is the
// only place `status` gets set to "paid" — every VIP/milestone eligibility
// check and the auto-renew due-date logic reads that field, not confirmed_at.
// ----------------------------------------------------------
async function confirmPayment(clientOrderId: string) {
  const { data: order, error: orderError } = await db
    .from("orders")
    .select("id, status")
    .eq("client_order_id", clientOrderId)
    .maybeSingle();

  if (orderError) throw new Error(`Order lookup failed: ${orderError.message}`);
  if (!order) return { confirmed: false, reason: "Order not found." };
  if (order.status === "paid") {
    return { confirmed: false, reason: "Order was already marked paid." };
  }

  const { error: updateError } = await db
    .from("orders")
    .update({ status: "paid" })
    .eq("id", order.id);

  if (updateError) throw new Error(`Order update failed: ${updateError.message}`);

  return { confirmed: true };
}

function membershipPayload(eligibility: {
  completedCount: number;
  isVip: boolean;
  isMilestone: boolean;
  streakInfo: StreakInfo;
}) {
  const s = eligibility.streakInfo;
  return {
    tier: eligibility.isVip ? IRONCLAD_TIER : LEAD_TIER,
    completed_orders: eligibility.completedCount,
    next_order: eligibility.completedCount + 1,
    is_vip: eligibility.isVip,
    is_milestone: eligibility.isMilestone,
    streak: s.streak,
    best_streak: s.bestStreak,
    streak_target: MEMBERSHIP_STREAK_ORDERS,
    streak_alive: s.alive,
    pickup_deadline: s.pickupDeadline ? s.pickupDeadline.toISOString() : null,
    last_window_end: s.lastWindowEnd ? s.lastWindowEnd.toISOString() : null,
  };
}

// Deducts credits a client has just been handed in person. The update only
// succeeds if the balance is still what we just read, so two redemptions (or a
// redemption landing at the same moment as a new credit) can never overwrite
// each other. A short retry loop covers that rare collision.
async function redeemReferralCredits(
  phone: string,
  credits: number,
): Promise<
  | { ok: true; redeemed: number; remaining: number }
  | { ok: false; status: number; error: string }
> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: userRow, error: lookupError } = await db
      .from("users")
      .select("id, referral_credits")
      .eq("phone_number", phone)
      .maybeSingle();
    if (lookupError) throw new Error(`Credit lookup failed: ${lookupError.message}`);
    if (!userRow) return { ok: false, status: 404, error: "No client found with that phone number." };

    const balance = userRow.referral_credits ?? 0;
    if (credits > balance) {
      return { ok: false, status: 409, error: `Only ${balance} credit(s) available — can't redeem ${credits}.` };
    }

    const remaining = balance - credits;
    let update = db.from("users").update({ referral_credits: remaining }).eq("id", userRow.id);
    update = userRow.referral_credits === null || userRow.referral_credits === undefined
      ? update.is("referral_credits", null)
      : update.eq("referral_credits", userRow.referral_credits);
    const { data: updated, error: updateError } = await update.select("id");
    if (updateError) throw new Error(`Credit update failed: ${updateError.message}`);

    if (updated && updated.length > 0) {
      // Audit trail so you can always see what was handed out and when.
      // Best-effort: a missing log table never blocks the redemption itself.
      const { error: logError } = await db
        .from("referral_redemptions")
        .insert({ phone_number: phone, credits, balance_after: remaining });
      if (logError) console.error("Redemption log failed:", logError.message);

      return { ok: true, redeemed: credits, remaining };
    }
    // The balance changed between our read and write — read it again.
  }
  return { ok: false, status: 409, error: "The balance changed while redeeming. Check it again and retry." };
}

async function getRenewalStatus(phone: string) {
  const { data: latest, error } = await db
    .from("orders")
    .select("client_order_id, created_at, duration_days, plan_type, auto_renew, renewal_cancelled_at, renewed_at, status, net_amount, total_kes")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Renewal lookup failed: ${error.message}`);
  if (!latest || !latest.auto_renew || latest.renewal_cancelled_at) {
    return { active: false, nextRenewalEstimate: null, orderId: null, pendingPayment: false };
  }

  // If this latest row is itself an unpaid, auto-generated renewal order,
  // the customer just needs to pay — no future date to show.
  if (latest.status !== "paid") {
    return {
      active: true,
      pendingPayment: true,
      nextRenewalEstimate: null,
      orderId: latest.client_order_id,
      amountDue: latest.net_amount ?? latest.total_kes ?? null,
    };
  }

  if (latest.renewed_at) {
    // Already renewed into a follow-up order; that row (fetched above) will
    // actually be the pending one once it exists, so this branch is mostly
    // a safety net for any timing gap right around the cron run.
    return { active: true, pendingPayment: true, nextRenewalEstimate: null, orderId: latest.client_order_id, amountDue: null };
  }

  const durationDays = latest.duration_days ?? 0;
  const createdAt = new Date(latest.created_at);
  const nextRenewalEstimate = new Date(createdAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

  return {
    active: true,
    pendingPayment: false,
    nextRenewalEstimate: nextRenewalEstimate.toISOString(),
    orderId: latest.client_order_id,
    amountDue: null,
  };
}

async function cancelRenewal(phone: string) {
  const { data: latest, error: lookupError } = await db
    .from("orders")
    .select("id, client_order_id, auto_renew, renewal_cancelled_at")
    .eq("phone_number", phone)
    .eq("auto_renew", true)
    .is("renewal_cancelled_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupError) throw new Error(`Cancel lookup failed: ${lookupError.message}`);
  if (!latest) return { cancelled: false };

  const { error: updateError } = await db
    .from("orders")
    .update({ renewal_cancelled_at: new Date().toISOString() })
    .eq("id", latest.id);

  if (updateError) throw new Error(`Cancel update failed: ${updateError.message}`);
  return { cancelled: true };
}

serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }

    const body = await req.json().catch(() => null);

    if (body?.membership_only === true) {
      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const eligibility = await getIroncladEligibility(phone);

      return jsonResponse({
        status: "membership",
        membership: membershipPayload(eligibility),
      }, 200);
    }

    if (body?.saturation_status === true) {
      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const saturation = await getCurrentSaturationStatus(phone);
      return jsonResponse({ status: "saturation", saturation }, 200);
    }

    if (body?.renewal_only === true) {
      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const renewal = await getRenewalStatus(phone);
      return jsonResponse({ status: "renewal", renewal }, 200);
    }

    if (body?.cancel_renewal === true) {
      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const result = await cancelRenewal(phone);
      return jsonResponse({ status: "cancelled", ...result }, 200);
    }

    if (body?.confirm_payment === true) {
      if (!ADMIN_SECRET || body?.admin_secret !== ADMIN_SECRET) {
        return jsonResponse({ error: "Unauthorized." }, 401);
      }

      const clientOrderId = typeof body?.client_order_id === "string" ? body.client_order_id.trim() : "";
      if (!clientOrderId) {
        return jsonResponse({ error: "client_order_id is required to confirm payment." }, 400);
      }

      const result = await confirmPayment(clientOrderId);
      return jsonResponse({ status: "payment_confirmation", ...result }, result.confirmed ? 200 : 409);
    }

    if (body?.confirm_delivery === true) {
      if (!ADMIN_SECRET || body?.admin_secret !== ADMIN_SECRET) {
        return jsonResponse({ error: "Unauthorized." }, 401);
      }

      const clientOrderId = typeof body?.client_order_id === "string" ? body.client_order_id.trim() : "";
      if (!clientOrderId) {
        return jsonResponse({ error: "client_order_id is required to confirm delivery." }, 400);
      }

      const pickupDate = typeof body?.pickup_date === "string" && body.pickup_date.trim() ? body.pickup_date.trim() : undefined;
      const result = await confirmDelivery(clientOrderId, pickupDate);
      return jsonResponse({ status: "delivery_confirmation", ...result }, result.confirmed ? 200 : 409);
    }

    if (body?.referral_status === true) {
      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const { data: userRow, error: userError } = await db
        .from("users")
        .select("referral_credits")
        .eq("phone_number", phone)
        .maybeSingle();

      if (userError) {
        return jsonResponse({ error: "Referral lookup failed.", details: userError.message }, 500);
      }

      return jsonResponse({
        status: "referral",
        referral: {
          phone,
          credits: userRow?.referral_credits ?? 0,
        },
      }, 200);
    }

    if (body?.redeem_referral_credits === true) {
      if (!ADMIN_SECRET || body?.admin_secret !== ADMIN_SECRET) {
        return jsonResponse({ error: "Unauthorized." }, 401);
      }

      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const credits = Number(body?.credits);
      if (!Number.isInteger(credits) || credits <= 0) {
        return jsonResponse({ error: "credits must be a whole number greater than 0." }, 400);
      }

      const result = await redeemReferralCredits(phone, credits);
      if (!result.ok) {
        return jsonResponse({ error: result.error }, result.status);
      }
      return jsonResponse({ status: "redeemed", redeemed: result.redeemed, remaining: result.remaining }, 200);
    }

    if (body?.validate_referrer === true) {
      const clientPhone = normalizePhone(body?.client_phone);
      // Reuses the exact same rules the quote and real-order paths enforce
      // — including admin/marketing codes — so this preview can never say
      // "valid" for something the real order would then reject, or vice
      // versa.
      const referralCheck = await validateReferral(clientPhone, body?.phone_number);

      return jsonResponse({
        status: "referrer_validation",
        valid: referralCheck.ok,
        phone: referralCheck.ok ? referralCheck.referredByPhone : undefined,
        message: referralCheck.ok
          ? "Verified"
          : referralCheck.error,
        error: referralCheck.ok ? undefined : referralCheck.error,
      }, 200);
    }

    if (body?.list_pending_orders === true) {
      if (!ADMIN_SECRET || body?.admin_secret !== ADMIN_SECRET) {
        return jsonResponse({ error: "Unauthorized." }, 401);
      }

      const { data: pending, error: pendingError } = await db
        .from("orders")
        .select("client_order_id, phone_number, plan_name, duration_days, total_sachets, bonus_sachets, net_amount, location, gym, created_at, auto_renew, confirmed_at, status")
        // "Pending" now means not fully processed yet — either delivery or
        // payment (or both) still outstanding. An order only drops off this
        // list once it's both delivered AND marked paid.
        .or("confirmed_at.is.null,status.is.null,status.neq.paid")
        .order("created_at", { ascending: true })
        .limit(100);

      if (pendingError) {
        return jsonResponse({ error: "Failed to list pending orders.", details: pendingError.message }, 500);
      }

      const orders = pending ?? [];

      return jsonResponse({ status: "pending_orders", orders }, 200);
    }

    if (body?.get_streak === true) {
      if (!ADMIN_SECRET || body?.admin_secret !== ADMIN_SECRET) {
        return jsonResponse({ error: "Unauthorized." }, 401);
      }
      const phone = normalizePhone(body?.phone_number);
      if (!PHONE_REGEX.test(phone)) {
        return jsonResponse({ error: "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX." }, 400);
      }

      const { data: userRow, error: userError } = await db
        .from("users")
        .select("id")
        .eq("phone_number", phone)
        .maybeSingle();
      if (userError) return jsonResponse({ error: "Lookup failed.", details: userError.message }, 500);

      const eligibility = await getIroncladEligibility(phone);
      const m = membershipPayload(eligibility);

      return jsonResponse({
        status: "streak",
        client: {
          phone,
          known: !!userRow,
          paid_orders: eligibility.paidCount,
          completed_orders: m.completed_orders,
          streak: m.streak,
          best_streak: m.best_streak,
          streak_target: m.streak_target,
          streak_alive: m.streak_alive,
          is_member: m.is_vip,
          pickup_deadline: m.pickup_deadline,
          last_window_end: m.last_window_end,
        },
      }, 200);
    }

    if (body?.list_nudges === true) {
      if (!ADMIN_SECRET || body?.admin_secret !== ADMIN_SECRET) {
        return jsonResponse({ error: "Unauthorized." }, 401);
      }
      const now = new Date();

      const { data: delivered, error: deliveredError } = await db
        .from("orders")
        .select("phone_number, confirmed_at, duration_days, status")
        .not("confirmed_at", "is", null)
        .order("confirmed_at", { ascending: true });
      if (deliveredError) return jsonResponse({ error: "Failed to load deliveries.", details: deliveredError.message }, 500);

      // Orders a client placed themselves that haven't been delivered yet
      // mean they're already coming back, so no nudge. Auto-renewed orders
      // don't count: a pending one that nobody collects is exactly the case
      // that needs a nudge.
      const { data: waiting, error: waitingError } = await db
        .from("orders")
        .select("phone_number, created_at")
        .is("confirmed_at", null)
        .is("renewed_from_order_id", null);
      if (waitingError) return jsonResponse({ error: "Failed to load waiting orders.", details: waitingError.message }, 500);

      const deliveredByPhone = new Map<string, Array<DeliveredOrder & { status: string | null }>>();
      for (const row of delivered ?? []) {
        const list = deliveredByPhone.get(row.phone_number) ?? [];
        list.push(row);
        deliveredByPhone.set(row.phone_number, list);
      }
      const waitingByPhone = new Map<string, Date[]>();
      for (const row of waiting ?? []) {
        const list = waitingByPhone.get(row.phone_number) ?? [];
        list.push(new Date(row.created_at));
        waitingByPhone.set(row.phone_number, list);
      }

      const DAY_MS = 24 * 60 * 60 * 1000;
      const nudges: Array<Record<string, unknown>> = [];
      for (const [phone, history] of deliveredByPhone) {
        const last = history[history.length - 1];
        const lastPickup = new Date(last.confirmed_at);
        if ((waitingByPhone.get(phone) ?? []).some((created) => created > lastPickup)) continue;

        const windowEnd = addDays(lastPickup, last.duration_days ?? 1);
        const daysToWindowEnd = (windowEnd.getTime() - now.getTime()) / DAY_MS;
        if (daysToWindowEnd > NUDGE_LEAD_DAYS) continue;

        const s = computeStreak(history.filter((h) => h.status === "paid"), now);
        nudges.push({
          phone,
          member: s.member,
          streak: s.streak,
          streak_alive: s.alive,
          window_end: windowEnd.toISOString(),
          days_to_window_end: round2(daysToWindowEnd),
          pickup_deadline: s.pickupDeadline ? s.pickupDeadline.toISOString() : null,
        });
      }
      nudges.sort((x, y) => Number(x.days_to_window_end) - Number(y.days_to_window_end));

      return jsonResponse({ status: "nudges", nudges }, 200);
    }

    const isQuote = body?.quote_only === true;
    const validationError = validatePayload(body, !isQuote);

    if (validationError) {
      return jsonResponse({ error: validationError }, 400);
    }

    const phone = normalizePhone(body.phone_number);
    const weight = Number(body.body_weight_kg);

    const eligibility = await getIroncladEligibility(phone);

    const saturation = await getCurrentSaturationStatus(phone, weight);
    const requestedDosesPerDay = body.doses_per_day != null ? Number(body.doses_per_day) : undefined;
    const requestedDurationDays = body.duration_days != null ? Number(body.duration_days) : undefined;
    if (requestedDurationDays != null && (!Number.isInteger(requestedDurationDays) || requestedDurationDays < MIN_ORDER_DAYS || requestedDurationDays > MAX_ORDER_DAYS)) {
      return jsonResponse({ error: `duration_days must be a whole number from ${MIN_ORDER_DAYS} to ${MAX_ORDER_DAYS}.` }, 400);
    }

    // Referral only ever applies to a client's first PAID order — same rule
    // the real order enforces below, and reusing eligibility.paidCount
    // (paid orders only) for the same reason: an abandoned/pending prior
    // attempt shouldn't disqualify a genuine first-time buyer. Checked here
    // too so the quote preview shows the real, referral-adjusted price
    // instead of surprising the client with a different number at
    // submission.
    let referredByPhoneForQuote: string | null = null;
    if (isQuote) {
      if (eligibility.paidCount === 0) {
        const referralCheck = await validateReferral(phone, body.referred_by_phone);
        if (!referralCheck.ok) {
          return jsonResponse({ error: referralCheck.error }, 400);
        }
        referredByPhoneForQuote = referralCheck.referredByPhone;
      }
    }

    if (isQuote) {
      if (saturation.isSaturated) {
        const financials = calculateOrderFinancials({
          isSaturated: true,
          currentStoreGrams: 0,
          thresholdGrams: 0,
          bodyWeightKg: weight,
          requestedDurationDays,
          isVip: eligibility.isVip,
          isMilestone: eligibility.isMilestone,
          isReferredFirstOrder: referredByPhoneForQuote !== null,
        });
        return jsonResponse({
          status: "quote",
          membership: membershipPayload(eligibility),
          saturation,
          maintenance_plan: {
            doses_per_day: financials.dosesPerDay,
            duration_days: financials.durationDays,
            gross_amount: financials.grossAmount,
            discount_amount: financials.discountAmount,
            net_amount: financials.netAmount,
            discount_applied: financials.discountApplied,
            bonus_sachets: financials.bonusSachets,
            note: `You're saturated — ${financials.dosesPerDay} sachet${financials.dosesPerDay > 1 ? 's' : ''}/day maintains it. An occasional lighter week won't cost you results.`,
          },
        }, 200);
      }

      // Heavy clients (>=80kg) are locked to 2x/day at the standard 2x price —
      // show them only that one option rather than a menu of tiers that
      // calculateOrderFinancials would silently override anyway. Avoids any
      // chance of the frontend showing a price for a tier the client can't
      // actually get.
      let menu;
      if (weight >= HEAVY_CLIENT_THRESHOLD_KG) {
        menu = generateSaturationTierMenu(saturation.currentStoreGrams, saturation.thresholdGrams).filter(
          (t) => t.dosesPerDay === HEAVY_CLIENT_DOSES_PER_DAY,
        );
      } else {
        menu = generateSaturationTierMenu(saturation.currentStoreGrams, saturation.thresholdGrams);
      }
      if (menu.length === 0) {
        return jsonResponse({
          status: "quote",
          membership: membershipPayload(eligibility),
          saturation,
          tier_menu: [],
          error: "No saturation tier could be generated for this weight — please retry or contact support.",
        }, 200);
      }

      let selectedTier = null;
      if (requestedDosesPerDay != null) {
        const financials = calculateOrderFinancials({
          isSaturated: false,
          currentStoreGrams: saturation.currentStoreGrams,
          thresholdGrams: saturation.thresholdGrams,
          bodyWeightKg: weight,
          requestedDosesPerDay,
          requestedDurationDays,
          isVip: eligibility.isVip,
          isMilestone: eligibility.isMilestone,
          isReferredFirstOrder: referredByPhoneForQuote !== null,
        });
        selectedTier = {
          doses_per_day: financials.dosesPerDay,
          duration_days: financials.durationDays,
          gross_amount: financials.grossAmount,
          discount_amount: financials.discountAmount,
          net_amount: financials.netAmount,
          discount_applied: financials.discountApplied,
          bonus_sachets: financials.bonusSachets,
          natural_duration_days: financials.naturalDurationDays,
          maintenance_days: financials.maintenanceDays,
        };
      }

      return jsonResponse({
        status: "quote",
        membership: membershipPayload(eligibility),
        saturation,
        tier_menu: menu.map((t) => ({
          doses_per_day: t.dosesPerDay,
          days_to_saturate: t.daysToSaturate,
          daily_cost: t.dailyCost,
          total_cost: t.totalCost,
          total_sachets: t.totalSachets,
        })),
        selected_tier: selectedTier,
      }, 200);
    }

    const clientOrderId = body.client_order_id.trim();
    const { data: existingOrder, error: existingOrderError } = await db
      .from("orders")
      .select("*")
      .eq("client_order_id", clientOrderId)
      .maybeSingle();

    if (existingOrderError) {
      return jsonResponse({ error: "Failed to check existing order.", details: existingOrderError.message }, 500);
    }

    if (existingOrder) {
      return jsonResponse({
        status: "exists",
        order: existingOrder,
        pricing: {
          gross_amount: existingOrder.gross_amount,
          discount_amount: existingOrder.discount_amount,
          net_amount: existingOrder.net_amount ?? existingOrder.total_kes,
          discount_applied: existingOrder.discount_applied ?? "NONE",
        },
      }, 200);
    }

    if (!saturation.isSaturated && requestedDosesPerDay == null) {
      return jsonResponse({ error: "doses_per_day is required to place a saturation-phase order." }, 400);
    }

    // Referral tagging: only on a client's first PAID order, and only
    // once — never overwritten on later orders. Deliberately reuses
    // eligibility.paidCount (paid orders only) rather than counting every
    // row ever inserted for this phone — an abandoned/pending order from an
    // earlier attempt shouldn't disqualify a genuine first-time buyer from
    // the referral discount just because a row exists. This validation
    // (self-referral blocked, referrer must be a real paid/confirmed
    // client) is what makes the referral discount below safe — it can't be
    // faked without first satisfying every check that already protects the
    // referrer's own credit.
    const isFirstOrderEver = eligibility.paidCount === 0;

    let referredByPhone: string | null = null;
    if (isFirstOrderEver && typeof body.referred_by_phone === "string" && body.referred_by_phone.trim()) {
      const referralCheck = await validateReferral(phone, body.referred_by_phone);
      if (!referralCheck.ok) {
        return jsonResponse({ error: referralCheck.error }, 400);
      }
      referredByPhone = referralCheck.referredByPhone;
    }

    let financials;
    try {
      financials = calculateOrderFinancials({
        isSaturated: saturation.isSaturated,
        currentStoreGrams: saturation.currentStoreGrams,
        thresholdGrams: saturation.thresholdGrams,
        bodyWeightKg: weight,
        requestedDosesPerDay,
        requestedDurationDays,
        isVip: eligibility.isVip,
        isMilestone: eligibility.isMilestone,
        isReferredFirstOrder: referredByPhone !== null,
      });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : "Invalid tier selection." }, 400);
    }

    const autoRenew = body.auto_renew === true;

    const userId = await getOrCreateUser({
      phone,
      weight,
      location: typeof body.location === "string" ? body.location.trim() : "",
      gym: typeof body.gym === "string" ? body.gym.trim() : "",
    });

    const planName = saturation.isSaturated
      ? `Maintenance (${financials.dosesPerDay}x/day)`
      : `Saturation Plan (${financials.dosesPerDay}x/day)`;

    const orderPayload = {
      client_order_id: clientOrderId,
      user_id: userId,
      phone_number: phone,
      plan_type: saturation.isSaturated ? "daily_maintenance" : "fast_saturation",
      plan_name: planName,
      body_weight_kg: weight,
      duration_days: financials.durationDays,
      total_sachets: financials.totalSachets,
      location: typeof body.location === "string" ? body.location.trim() : "",
      gym: typeof body.gym === "string" ? body.gym.trim() : "",
      message: typeof body.message === "string" ? body.message.trim() : "",

      gross_amount: financials.grossAmount,
      discount_amount: financials.discountAmount,
      net_amount: financials.netAmount,
      total_kes: financials.netAmount,
      discount_applied: financials.discountApplied,
      bonus_sachets: financials.bonusSachets,

      is_milestone_reward: eligibility.isMilestone,
      auto_renew: autoRenew,
      renewal_cancelled_at: null,
      grams_delivered: financials.gramsDelivered,
      referred_by_phone: referredByPhone,
    };

    const { data: insertedOrder, error: insertError } = await db
      .from("orders")
      .insert(orderPayload)
      .select()
      .single();

    if (insertError || !insertedOrder) {
      const errorText = insertError?.message ?? "Failed to create order.";

      if (/duplicate|unique|client_order_id/i.test(errorText)) {
        const { data: racedOrder, error: raceLookupError } = await db
          .from("orders")
          .select("*")
          .eq("client_order_id", clientOrderId)
          .maybeSingle();

        if (!raceLookupError && racedOrder) {
          return jsonResponse({
            status: "exists",
            order: racedOrder,
            pricing: {
              gross_amount: racedOrder.gross_amount,
              discount_amount: racedOrder.discount_amount,
              net_amount: racedOrder.net_amount ?? racedOrder.total_kes,
              discount_applied: racedOrder.discount_applied ?? "NONE",
            },
          }, 200);
        }
      }

      return jsonResponse({ error: "Failed to create order.", details: errorText }, 500);
    }

    return jsonResponse({
      status: "ok",
      order: insertedOrder,
      membership: membershipPayload(eligibility),
      pricing: {
        gross_amount: financials.grossAmount,
        discount_amount: financials.discountAmount,
        net_amount: financials.netAmount,
        discount_applied: financials.discountApplied,
        bonus_sachets: financials.bonusSachets,
        bonus_value_kes: financials.bonusValueKes,
        natural_duration_days: financials.naturalDurationDays,
        maintenance_days: financials.maintenanceDays,
      },
    }, 201);
  } catch (error) {
    console.error("Order handler error:", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});