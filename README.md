# Pumping Iron — Supabase Edge Function Setup

This repository includes a production-ready Supabase Edge Function for order handling.

## Files added

- `supabase/functions/order-handler/index.ts`
- `supabase/functions/order-handler/README.md`

## Edge Function purpose

The Edge Function performs:

- payload validation
- idempotent order insert via `client_order_id`
- membership streak increment
- `membership_incremented` state update

## Deploying the function

1. Install Supabase CLI.
2. Log in and select the project.
3. Deploy from the repo root:

```bash
cd /home/macin/Desktop/Desktop/pumping-iron
supabase functions deploy order-handler --project-ref YOUR_PROJECT_REF
```

4. Set required secrets:

```bash
supabase secrets set SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

5. Use the function endpoint in your front-end instead of direct Supabase inserts.

## Recommended production flow

1. Frontend sends validated request to Edge Function.
2. Edge Function writes to `orders` table and updates `memberships` table.
3. Client receives canonical response and shows success.
