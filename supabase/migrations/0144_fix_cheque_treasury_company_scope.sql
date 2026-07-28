-- 0144: Scope cash-cheque treasury updates to the cheque's company.
--
-- BUG: cheque_apply_balance() updated the wrong company's Cash in Hand for cash
-- cheques — clearance used `WHERE id = (SELECT id FROM treasury LIMIT 1)`
-- (nondeterministic company) and the revert/delete paths had NO where clause at
-- all (they adjusted EVERY company's treasury). Result: clearing a cash cheque
-- left the owning company's Cash in Hand unchanged while another company's moved,
-- and Total Cash dropped by just the bank side.
--
-- FIX: every treasury update is scoped by the cheque's company_id, and clearance
-- creates the treasury row if the company has none. Only the three cash-cheque
-- treasury statements change; all other behaviour is identical to before.

create or replace function public.cheque_apply_balance()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  linked_total numeric(14,2) := 0;
  type_label text;
  is_receivables boolean;
BEGIN
  -- ── INSERT ──────────────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    IF NEW.direction = 'incoming' THEN
      is_receivables := (NEW.invoice_id IS NOT NULL OR NEW.client_id IS NOT NULL);
      INSERT INTO public.bank_transactions
        (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
      VALUES
        (NEW.bank_account_id, 'cheque', NEW.amount, 0, 0,
         CASE WHEN is_receivables THEN 'Receivables cheque' ELSE 'Deposit cheque' END
           || ' #' || NEW.cheque_number
           || COALESCE(' from ' || NEW.recipient, '') || ' received (pending)',
         NEW.id);
    ELSE
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
      is_receivables := (OLD.invoice_id IS NOT NULL OR OLD.client_id IS NOT NULL);
      IF OLD.status = 'pending' THEN
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, 0,
           'Pending ' || CASE WHEN is_receivables THEN 'receivables' ELSE 'deposit' END
           || ' cheque #' || OLD.cheque_number || ' deleted (no balance change)',
           OLD.id);
      ELSIF OLD.status = 'cleared' THEN
        UPDATE public.bank_accounts
           SET balance = balance - OLD.amount, updated_at = now()
         WHERE id = OLD.bank_account_id;
        IF is_receivables THEN
          DELETE FROM public.invoice_payments WHERE cheque_id = OLD.id;
          IF OLD.invoice_id IS NOT NULL THEN
            UPDATE public.invoices
               SET amount_received = GREATEST(0, amount_received - OLD.amount), updated_at = now()
             WHERE id = OLD.invoice_id;
          END IF;
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (OLD.bank_account_id, 'cheque', OLD.amount, 0, -OLD.amount,
           'Cleared ' || CASE WHEN is_receivables THEN 'receivables' ELSE 'deposit' END
           || ' cheque #' || OLD.cheque_number || ' deleted (bank reversed)',
           OLD.id);
      END IF;
    ELSE
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
           SET cash_balance = cash_balance - OLD.amount, updated_at = now()
         WHERE company_id = OLD.company_id;
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
        is_receivables := (NEW.invoice_id IS NOT NULL OR NEW.client_id IS NOT NULL);
        UPDATE public.bank_accounts
           SET balance = balance + NEW.amount, updated_at = now()
         WHERE id = NEW.bank_account_id;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, NEW.amount,
           CASE WHEN is_receivables THEN 'Receivables cheque' ELSE 'Deposit cheque' END
           || ' #' || NEW.cheque_number || ' cleared (bank credited)',
           NEW.id);
        IF is_receivables THEN
          INSERT INTO public.invoice_payments
            (invoice_id, client_id, amount, payment_date, payment_mode, bank_account_id, cheque_id, notes)
          VALUES
            (NEW.invoice_id, NEW.client_id, NEW.amount, CURRENT_DATE, 'Cheque', NEW.bank_account_id, NEW.id, NEW.notes);
          IF NEW.invoice_id IS NOT NULL THEN
            UPDATE public.invoices
               SET amount_received = amount_received + NEW.amount, updated_at = now()
             WHERE id = NEW.invoice_id;
          END IF;
        END IF;

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
        UPDATE public.treasury
           SET cash_balance = cash_balance + NEW.amount, updated_at = now()
         WHERE company_id = NEW.company_id;
        IF NOT FOUND THEN
          INSERT INTO public.treasury (company_id, cash_balance) VALUES (NEW.company_id, NEW.amount);
        END IF;
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
        is_receivables := (NEW.invoice_id IS NOT NULL OR NEW.client_id IS NOT NULL);
        UPDATE public.bank_accounts
           SET balance = balance - NEW.amount, updated_at = now()
         WHERE id = NEW.bank_account_id;
        IF is_receivables THEN
          DELETE FROM public.invoice_payments WHERE cheque_id = NEW.id;
          IF NEW.invoice_id IS NOT NULL THEN
            UPDATE public.invoices
               SET amount_received = GREATEST(0, amount_received - NEW.amount), updated_at = now()
             WHERE id = NEW.invoice_id;
          END IF;
        END IF;
        INSERT INTO public.bank_transactions
          (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
        VALUES
          (NEW.bank_account_id, 'cheque', NEW.amount, 0, -NEW.amount,
           CASE WHEN is_receivables THEN 'Receivables cheque' ELSE 'Deposit cheque' END
           || ' #' || NEW.cheque_number || ' clearance reverted', NEW.id);
      ELSIF NEW.cheque_type = 'cash' THEN
        UPDATE public.treasury
           SET cash_balance = cash_balance - NEW.amount, updated_at = now()
         WHERE company_id = NEW.company_id;
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
$function$;
