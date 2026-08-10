# Supabase Edge Function: Order Handler

This Edge Function safely inserts an order into Supabase without updating membership streaks automatically.
It is designed for production use with the service role key. Do not expose the service role key to client code.

## What it does

1. Validates the request payload.
2. Checks for an existing order by `client_order_id`.
3. If the order already exists, returns the existing order.
4. If the order is new, inserts it into `orders` with `membership_incremented = false`.
5. Leaves membership streak updates and completion status to admin control.

## Required environment variables

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Deploy steps

1. Install Supabase CLI if not already installed.
2. From the repository root:

```bash
cd /home/macin/Desktop/Desktop/pumping-iron
supabase functions deploy order-handler --project-ref YOUR_PROJECT_REF
```

3. Set environment variables via Supabase:

```bash
supabase secrets set SUPABASE_URL=https://your-project.supabase.co SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

4. Call the function from the front-end using its deployed URL.

## Example payload

```json
{
  "client_order_id": "abc123-2026-08-10",
  "phone_number": "+254712345678",
  "plan_name": "Fast Saturation (5 Days)",
  "weight_class": "Class C",
  "total_kes": 1220,
  "location": "Ruiru",
  "gym": "Max Gym",
  "is_member": false,
  "message": "Order request via web"
}
```

## Required database helper

This function assumes an `increment_membership_orders(phone_number text)` stored procedure exists.
Create it in Supabase SQL editor with:

```sql
create or replace function public.increment_membership_orders(phone_number text)
returns void language plpgsql as $$
begin
  insert into public.memberships (phone_number, completed_orders, created_at)
  values (phone_number, 1, now())
  on conflict (phone_number) do update
  set completed_orders = public.memberships.completed_orders + 1;
end;
$$;
```

Alternatively, you may replace the RPC call with direct membership upsert logic in the Edge Function if you prefer not to use a stored procedure.
