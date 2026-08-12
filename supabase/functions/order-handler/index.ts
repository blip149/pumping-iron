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

const PHONE_REGEX = /^\+254[17]\d{8}$/;
const IRONCLAD_TIER = "ironclad_vip";
const LEAD_TIER = "lead";

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

type WeightClass = (typeof WEIGHT_CLASSES)[number];
type PlanType = "fast_saturation" | "daily_maintenance";

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

function normalizeWeightClass(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim().replace(/^Class\s*/i, "").trim().toUpperCase();
  return value.length === 1 ? value : value.slice(-1);
}

function getWeightClass(weight: number): WeightClass | null {
  return WEIGHT_CLASSES.find((item) => weight >= item.min && weight <= item.max) ?? null;
}

function getMylarCost(grams: number): number {
  return grams <= 4.5 ? MYLAR_SMALL : MYLAR_LARGE;
}

function getSachetCost(grams: number): number {
  return round2(PPG * grams + getMylarCost(grams));
}

function getSachetPrice(grams: number, bonusProfit = 0): number {
  return roundUpKES(getSachetCost(grams) + BASE_PROFIT + bonusProfit);
}

function isPlanType(value: unknown): value is PlanType {
  return value === "fast_saturation" || value === "daily_maintenance";
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

  if (!isPlanType(body.plan_type)) {
    return "plan_type must be fast_saturation or daily_maintenance.";
  }

  const weight = Number(body.body_weight_kg);
  if (!Number.isFinite(weight) || weight < 30 || weight > 250) {
    return "body_weight_kg must be between 30 and 250 kg.";
  }

  const suppliedWeightClass = normalizeWeightClass(body.weight_class_short ?? body.weight_class);
  const computedWeightClass = getWeightClass(weight);
  if (!computedWeightClass) {
    return "Unsupported body weight.";
  }

  if (suppliedWeightClass && suppliedWeightClass !== computedWeightClass.name) {
    return "weight_class does not match body_weight_kg.";
  }

  if (body.plan_type === "daily_maintenance") {
    const duration = Number(body.duration_days);
    const trainingDays = Number(body.training_days_per_week);

    if (![7, 14, 21, 30].includes(duration)) {
      return "duration_days must be 7, 14, 21, or 30 for daily maintenance.";
    }

    if (!Number.isInteger(trainingDays) || trainingDays < 1 || trainingDays > 7) {
      return "training_days_per_week must be an integer from 1 to 7.";
    }
  }

  if (body.plan_type === "fast_saturation") {
    if (body.duration_days != null && Number(body.duration_days) !== 5) {
      return "Fast saturation has a fixed duration of 5 days.";
    }
  }

  return null;
}

async function getOrCreateUser(profile: {
  phone: string;
  weight: number;
  weightClass: string;
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
    weight_class: profile.weightClass,
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
// FIXED STREAK & ELIGIBILITY CALCULATOR
// ----------------------------------------------------------
async function getIroncladEligibility(phone: string) {
  const { count: totalPaid, error: totalError } = await db
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("phone_number", phone)
    .eq("status", "paid");

  if (totalError) throw new Error(`Failed to count orders: ${totalError.message}`);
  const paidCount = totalPaid || 0;

  // VIP status unlocks strictly AFTER 4 completed paid orders (incoming order is #5+)
  const isVip = paidCount >= 4;

  // Milestone applies on the 4th VIP order (Order #8, #12, #16...)
  const isMilestone = isVip && ((paidCount - 3) % 4 === 0);

  return { streakCount: paidCount, isVip, isMilestone };
}

function calculateFinancials(args: {
  planType: PlanType;
  weightClass: WeightClass;
  durationDays: number;
  trainingDaysPerWeek: number | null;
  isVip: boolean;
  isMilestone: boolean;
}) {
  let grossAmount: number;
  let totalSachets: number;
  let trainingSachetDays = 0;
  let restSachetDays = 0;

  if (args.planType === "fast_saturation") {
    totalSachets = 20;
    const sachetPrice = getSachetPrice(args.weightClass.sachetG, args.weightClass.bonusProfit);
    grossAmount = round2(sachetPrice * totalSachets);
  } else {
    if (!args.trainingDaysPerWeek || !Number.isInteger(args.trainingDaysPerWeek)) {
      throw new Error("Invalid training_days_per_week.");
    }

    const totalDays = args.durationDays;
    trainingSachetDays = Math.round((args.trainingDaysPerWeek / 7) * totalDays);
    restSachetDays = totalDays - trainingSachetDays;
    totalSachets = trainingSachetDays + restSachetDays;

    const trainingSachetPrice = getSachetPrice(args.weightClass.sachetG, args.weightClass.bonusProfit) + 5;
    const restSachetPrice = getSachetPrice(3.0, 0);

    const trainingSubtotal = round2(trainingSachetDays * trainingSachetPrice);
    const restSubtotal = round2(restSachetDays * restSachetPrice);
    grossAmount = round2(trainingSubtotal + restSubtotal);
  }

  let discountRate = 0;
  let discountApplied = "NONE";

  if (args.isMilestone) {
    discountRate = MILESTONE_DISCOUNT_RATE;
    discountApplied = "MILESTONE_30";
  } else if (args.isVip) {
    discountRate = MEMBER_DISCOUNT_RATE;
    discountApplied = "VIP_10";
  }

  const discountAmount = round2(grossAmount * discountRate);
  const netAmount = round2(grossAmount - discountAmount);

  return {
    grossAmount,
    discountAmount,
    netAmount,
    discountApplied,
    discountRate,
    totalSachets,
    trainingSachetDays,
    restSachetDays,
  };
}

function membershipPayload(eligibility: { streakCount: number; isVip: boolean; isMilestone: boolean }) {
  return {
    tier: eligibility.isVip ? IRONCLAD_TIER : LEAD_TIER,
    completed_orders: eligibility.streakCount,
    next_order: eligibility.streakCount + 1,
    is_vip: eligibility.isVip,
    is_milestone: eligibility.isMilestone,
  };
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

    const isQuote = body?.quote_only === true;
    const validationError = validatePayload(body, !isQuote);

    if (validationError) {
      return jsonResponse({ error: validationError }, 400);
    }

    const phone = normalizePhone(body.phone_number);
    const weight = Number(body.body_weight_kg);
    const weightClass = getWeightClass(weight);
    if (!weightClass) {
      return jsonResponse({ error: "Unsupported body weight." }, 400);
    }

    const suppliedClass = normalizeWeightClass(body.weight_class_short ?? body.weight_class);
    if (suppliedClass && suppliedClass !== weightClass.name) {
      return jsonResponse({ error: "weight_class does not match body_weight_kg." }, 400);
    }

    const planType = body.plan_type as PlanType;
    const durationDays = planType === "fast_saturation" ? 5 : Number(body.duration_days);
    const trainingDaysPerWeek = planType === "fast_saturation" ? null : Number(body.training_days_per_week);

    if (isQuote) {
      const eligibility = await getIroncladEligibility(phone);
      const financials = calculateFinancials({
        planType,
        weightClass,
        durationDays,
        trainingDaysPerWeek,
        isVip: eligibility.isVip,
        isMilestone: eligibility.isMilestone,
      });

      return jsonResponse({
        status: "quote",
        membership: membershipPayload(eligibility),
        pricing: {
          gross_amount: financials.grossAmount,
          discount_amount: financials.discountAmount,
          net_amount: financials.netAmount,
          discount_applied: financials.discountApplied,
        },
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

    const userId = await getOrCreateUser({
      phone,
      weight,
      weightClass: weightClass.name,
      location: typeof body.location === "string" ? body.location.trim() : "",
      gym: typeof body.gym === "string" ? body.gym.trim() : "",
    });

    const eligibility = await getIroncladEligibility(phone);

    const financials = calculateFinancials({
      planType,
      weightClass,
      durationDays,
      trainingDaysPerWeek,
      isVip: eligibility.isVip,
      isMilestone: eligibility.isMilestone,
    });

    const planName = planType === "fast_saturation" ? "Fast Saturation (5 Days)" : "Daily Maintenance";

    const orderPayload = {
      client_order_id: clientOrderId,
      user_id: userId,
      phone_number: phone,
      plan_type: planType,
      plan_name: planName,
      weight_class: weightClass.name,
      body_weight_kg: weight,
      duration_days: durationDays,
      training_days_per_week: trainingDaysPerWeek,
      total_sachets: financials.totalSachets,
      training_sachet_days: financials.trainingSachetDays,
      rest_sachet_days: financials.restSachetDays,
      location: typeof body.location === "string" ? body.location.trim() : "",
      gym: typeof body.gym === "string" ? body.gym.trim() : "",
      message: typeof body.message === "string" ? body.message.trim() : "",

      gross_amount: financials.grossAmount,
      discount_amount: financials.discountAmount,
      net_amount: financials.netAmount,
      total_kes: financials.netAmount,
      discount_applied: financials.discountApplied,

      is_milestone_reward: eligibility.isMilestone,
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
      },
    }, 201);
  } catch (error) {
    console.error("Order handler error:", error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});