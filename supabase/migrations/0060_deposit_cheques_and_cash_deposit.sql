-- Feature: Incoming (deposit) cheques + cash deposit groundwork
-- Adds a `direction` column to cheques:
--   'outgoing' = existing behaviour (deducts bank on issue, restores on delete)
--   'incoming' = deposit cheque received; bank credited ONLY on clearance

-- 1. Add direction column
ALTER TABLE public.cheques
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outgoing'
    CONSTRAINT cheques_direction_check CHECK (direction IN ('outgoing', 'incoming'));

-- 2. Rewrite cheque_apply_balance to handle both directions
CREATE OR REPLACE FUNCTION public.cheque_apply_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  linked_total numeric(14,2) := 0;
  trea_id uuid;
  type_label text;
BEGIN
  -- ── INSERT ──────────────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    IF NEW.direction = 'incoming' THEN
      -- Deposit cheque: balance NOT affected until cleared; just log receipt
      INSERT INTO public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      VALUES
        (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
         'Deposit cheque #' || NEW.cheque_number
           || COALESCE(' from ' || NEW.recipient, '') || ' received (pending)',
         NEW.id);
    ELSE
      -- Outgoing cheque: deduct from bank balance immediately (existing behaviour)
      UPDATE public.bank_accounts
         SET balance = balance - NEW.amount, updated_at = now()
       WHERE id = NEW.bank_account_id;
      type_label := CASE WHEN NEW.cheque_type = 'cash' THEN 'Cash' ELSE 'Payment' END;
      INSERT INTO public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      VALUES
        (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
         type_label || ' cheque #' || NEW.cheque_number
           || COALESCE(' to ' || NEW.recipient, '') || ' issued (pending)',
         NEW.id);
    END IF;
    RETURN NEW;

  -- ── DELETE ──────────────────────────────────────────────────────────────────
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.direction = 'incoming' THEN
      IF OLD.status = 'pending' THEN
        -- Nothing was credited; just log for audit
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, 0,
           'Pending deposit cheque #' || OLD.cheque_number || ' deleted (no balance change)',
           OLD.id);
      ELSIF OLD.status = 'cleared' THEN
        -- Reverse the bank credit applied on clearance
        UPDATE public.bank_accounts
           SET balance = balance - OLD.amount, updated_at = now()
         WHERE id = OLD.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, -OLD.amount,
           'Cleared deposit cheque #' || OLD.cheque_number || ' deleted (bank reversed)',
           OLD.id);
      END IF;
    ELSE
      -- Outgoing cheque delete (existing behaviour)
      IF OLD.status = 'pending' THEN
        UPDATE public.bank_accounts
           SET balance = balance + OLD.amount, updated_at = now()
         WHERE id = OLD.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, OLD.amount,
           'Pending cheque #' || OLD.cheque_number || ' deleted (bank restored)',
           OLD.id);
      ELSIF OLD.status = 'cleared' AND OLD.cheque_type = 'cash' THEN
        UPDATE public.treasury
           SET cash_balance = cash_balance - OLD.amount, updated_at = now();
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NULL, 'cheque', OLD.amount, -OLD.amount, 0,
           'Cash cheque #' || OLD.cheque_number || ' deleted (cash reversed)',
           OLD.id);
      END IF;
    END IF;
    RETURN OLD;

  -- ── UPDATE ──────────────────────────────────────────────────────────────────
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.amount <> OLD.amount OR NEW.bank_account_id <> OLD.bank_account_id THEN
      RAISE EXCEPTION 'Cheque amount and bank account cannot be changed after creation';
    END IF;
    IF NEW.cheque_type <> OLD.cheque_type THEN
      RAISE EXCEPTION 'Cheque type cannot be changed after creation';
    END IF;
    IF NEW.direction <> OLD.direction THEN
      RAISE EXCEPTION 'Cheque direction cannot be changed after creation';
    END IF;

    -- pending → cleared
    IF NEW.status = 'cleared' AND OLD.status = 'pending' THEN
      IF NEW.direction = 'incoming' THEN
        -- Credit the bank balance on clearance
        UPDATE public.bank_accounts
           SET balance = balance + NEW.amount, updated_at = now()
         WHERE id = NEW.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, NEW.amount,
           'Deposit cheque #' || NEW.cheque_number || ' cleared (bank credited)',
           NEW.id);
      ELSIF NEW.cheque_type = 'payment' THEN
        SELECT COALESCE(SUM(amount), 0) INTO linked_total FROM (
          SELECT net_salary AS amount FROM public.payslips         WHERE cheque_id = NEW.id
          UNION ALL
          SELECT amount               FROM public.expenses         WHERE cheque_id = NEW.id
          UNION ALL
          SELECT amount               FROM public.advances         WHERE cheque_id = NEW.id
          UNION ALL
          SELECT amount               FROM public.invoice_payments WHERE cheque_id = NEW.id
        ) s;
        IF linked_total <> NEW.amount THEN
          RAISE EXCEPTION 'Cannot clear payment cheque: linked items total PKR % but cheque is PKR %',
            linked_total, NEW.amount;
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
           'Payment cheque #' || NEW.cheque_number || ' cleared', NEW.id);
      ELSIF NEW.cheque_type = 'cash' THEN
        SELECT id INTO trea_id FROM public.treasury LIMIT 1;
        IF trea_id IS NULL THEN
          RAISE EXCEPTION 'No treasury row exists; cannot apply cash cheque clearance';
        END IF;
        UPDATE public.treasury
           SET cash_balance = cash_balance + NEW.amount, updated_at = now()
         WHERE id = trea_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NULL, 'cheque', NEW.amount, NEW.amount, 0,
           'Cash cheque #' || NEW.cheque_number || ' cleared (cash credited)', NEW.id);
      END IF;
      IF NEW.cleared_at IS NULL THEN
        NEW.cleared_at := NOW();
      END IF;
    END IF;

    -- cleared → pending (revert)
    IF NEW.status = 'pending' AND OLD.status = 'cleared' THEN
      IF NEW.direction = 'incoming' THEN
        UPDATE public.bank_accounts
           SET balance = balance - NEW.amount, updated_at = now()
         WHERE id = NEW.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
           'Deposit cheque #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      ELSIF NEW.cheque_type = 'cash' THEN
        UPDATE public.treasury
           SET cash_balance = cash_balance - NEW.amount, updated_at = now();
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NULL, 'cheque', NEW.amount, -NEW.amount, 0,
           'Cash cheque #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      ELSE
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
           'Payment cheque #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      END IF;
      NEW.cleared_at := NULL;
    END IF;

    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;
