import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PHONE_REGEX = /^\+254[17]\d{8}$/;

function corsHeaders() {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-max-age": "86400",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}

async function validatePayload(payload: any) {
  if (!payload || typeof payload !== "object") {
    return "Invalid JSON payload.";
  }

  for (const key of ["client_order_id", "phone_number"]) {
    if (!payload[key] || typeof payload[key] !== "string") {
      return `${key} is required and must be a string.`;
    }
  }

  if (!PHONE_REGEX.test(payload.phone_number)) {
    return "phone_number must be a valid Kenya E.164 number like +2547XXXXXXXX or +2541XXXXXXXX.";
  }

  if (typeof payload.total_kes !== "number" && typeof payload.total_kes !== "string") {
    return "total_kes is required and must be a number.";
  }

  if (payload.body_weight_kg != null && typeof payload.body_weight_kg !== "number" && typeof payload.body_weight_kg !== "string") {
    return "body_weight_kg must be a number if provided.";
  }

  if (payload.weight_class_short != null && typeof payload.weight_class_short !== "string") {
    return "weight_class_short must be a string if provided.";
  }

  const totalKes = Number(payload.total_kes);
  if (Number.isNaN(totalKes) || totalKes < 0) {
    return "total_kes must be a non-negative number.";
  }

  if (typeof payload.is_member !== "boolean") {
    return "is_member is required and must be a boolean.";
  }

  if (typeof payload.plan_name !== "string" || payload.plan_name.length === 0) {
    return "plan_name is required and must be a non-empty string.";
  }

  if (typeof payload.weight_class !== "string" || payload.weight_class.length === 0) {
    return "weight_class is required and must be a non-empty string.";
  }

  return null;
}

async function getOrCreateUser(profile: {
  phone_number: string;
  body_weight_kg?: number | string;
  weight_class_short?: string;
  weight_class?: string;
  location?: string;
  preferred_gym?: string;
}) {
  const { data: existingUser, error: lookupError } = await supabase
    .from("users")
    .select("id")
    .eq("phone_number", profile.phone_number)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  const profileData: Record<string, unknown> = {};
  if (profile.body_weight_kg != null) profileData.body_weight_kg = Number(profile.body_weight_kg);
  const weightClassSource = profile.weight_class_short?.trim() || profile.weight_class?.trim();
  if (weightClassSource) {
    const normalizedClass = weightClassSource.replace(/^Class\s*/i, '').trim();
    profileData.weight_class = normalizedClass.length === 1 ? normalizedClass : normalizedClass.slice(-1);
  }
  if (profile.location) profileData.location = profile.location;
  if (profile.preferred_gym) profileData.preferred_gym = profile.preferred_gym;

  if (existingUser) {
    if (Object.keys(profileData).length > 0) {
      const { error: updateError } = await supabase
        .from("users")
        .update(profileData)
        .eq("id", existingUser.id);

      if (updateError) {
        throw updateError;
      }
    }
    return existingUser.id;
  }

  const insertData = {
    phone_number: profile.phone_number,
    created_at: new Date().toISOString(),
    ...profileData,
  };

  const { data: newUser, error: insertError } = await supabase
    .from("users")
    .insert(insertData)
    .select("id")
    .maybeSingle();

  if (insertError) {
    const { data: retryUser, error: retryError } = await supabase
      .from("users")
      .select("id")
      .eq("phone_number", profile.phone_number)
      .maybeSingle();

    if (retryError || !retryUser) {
      throw insertError;
    }
    return retryUser.id;
  }

  if (!newUser) {
    throw new Error("Failed to create or find user.");
  }

  return newUser.id;
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Missing Supabase environment configuration." }, 500);
    }

    const body = await req.json().catch(() => null);
  const validationError = await validatePayload(body);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  const userPhone = body.phone_number.trim();
  const userId = await getOrCreateUser({
    phone_number: userPhone,
    body_weight_kg: body.body_weight_kg != null ? Number(body.body_weight_kg) : undefined,
    weight_class_short: body.weight_class_short?.trim(),
    weight_class: body.weight_class?.trim(),
    location: (body.location || "").trim(),
    preferred_gym: (body.gym || "").trim(),
  });

  const payload = {
    client_order_id: body.client_order_id.trim(),
    user_id: userId,
    phone_number: userPhone,
    plan_name: body.plan_name.trim(),
    weight_class: body.weight_class.trim(),
    total_kes: Number(body.total_kes),
    location: (body.location || "").trim(),
    gym: (body.gym || "").trim(),
    is_member: body.is_member,
    message: (body.message || "").trim(),
    membership_incremented: false,
  };

  const { data: existingOrder, error: lookupError } = await supabase
    .from("orders")
    .select("*")
    .eq("client_order_id", payload.client_order_id)
    .maybeSingle();

  if (lookupError) {
    return jsonResponse({ error: lookupError.message || "Failed to lookup existing order." }, 500);
  }

  if (existingOrder) {
    return jsonResponse({ status: "exists", order: existingOrder }, 200);
  }

  const { data: insertedOrder, error: insertError } = await supabase
    .from("orders")
    .insert([payload])
    .select()
    .maybeSingle();

  if (insertError || !insertedOrder) {
    const errorText = insertError?.message || "Failed to insert order.";
    if (errorText.includes('user_id') || errorText.includes('column "user_id"')) {
      const retryPayload = { ...payload };
      delete retryPayload.user_id;

      const { data: retriedOrder, error: retryError } = await supabase
        .from("orders")
        .insert([retryPayload])
        .select()
        .maybeSingle();

      if (retryError || !retriedOrder) {
        return jsonResponse({ error: retryError?.message || "Failed to insert order without user_id." }, 500);
      }

      return jsonResponse({
        status: "ok",
        order: retriedOrder,
        warning: "Order saved without user_id because the orders table does not contain that column yet.",
      }, 201);
    }

    return jsonResponse({ error: errorText }, 500);
  }

  return jsonResponse({ status: "ok", order: insertedOrder }, 201);
  } catch (err) {
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});
