import { FormEvent, useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';

type Account = { _id: string; label: string; number: string; balanceKobo: number };
type Transfer = { fromAccountId: string; bankCode: string; accountNumber: string; amountKobo: number; description: string; key: string };
type Pending = Transfer & { recipientName: string };
const banks = [ ['test', 'Paystack Test Bank'], ['access', 'Access Bank'], ['first', 'First Bank'], ['gtb', 'Guaranty Trust Bank'], ['uba', 'United Bank for Africa'], ['zenith', 'Zenith Bank'] ];
const money = (kobo: number) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(kobo / 100);

export default function ExternalTransferForm({ accounts, onCompleted }: { accounts: Account[]; onCompleted: (reference: string, mode: 'paystack-test' | 'local-demo') => void }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{ reference: string; mode: 'paystack-test' | 'local-demo' } | null>(null);

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setReceipt(null);
    const data = new FormData(event.currentTarget);
    const raw = String(data.get('amount'));
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) { setError('Enter an amount with up to two decimal places.'); return; }
    const [whole, fraction = ''] = raw.split('.');
    const amountKobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const fromAccountId = String(data.get('from'));
    if (!Number.isSafeInteger(amountKobo) || amountKobo < 100 || amountKobo > 100000000) { setError('Enter an amount between ₦1 and ₦1,000,000.'); return; }
    if (amountKobo > (accounts.find(account => account._id === fromAccountId)?.balanceKobo ?? 0)) { setError('That amount is greater than your available balance.'); return; }
    const bankCode = String(data.get('bank'));
    const accountNumber = String(data.get('number'));
    setBusy(true);
    try {
      const response = await fetch(`/api/external-transfers/resolve?${new URLSearchParams({ bankCode, accountNumber })}`, { credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join('. ') : result.message ?? 'Paystack could not verify this bank account.');
      setPending({ fromAccountId, bankCode, accountNumber, amountKobo, description: String(data.get('description')).trim(), key: crypto.randomUUID(), recipientName: result.accountName });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Paystack could not verify this bank account.'); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try {
      const { recipientName: _verifiedName, ...payload } = pending;
      const response = await fetch('/api/external-transfers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join('. ') : result.message ?? 'Test transfer could not be completed.');
      setReceipt({ reference: result.reference, mode: result.mode }); setPending(null); onCompleted(result.reference, result.mode);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test transfer could not be completed.'); }
    finally { setBusy(false); }
  }

  return <section className="panel external-panel">
    <div className="panel-title"><div><h2>Send to another bank</h2><p>Demo transfer using Paystack API integration.</p></div><span className="square-icon"><ArrowUpRight size={20}/></span></div>
    <form onSubmit={review} className="external-form">
      <div className="two-fields">
        <label>From account<select name="from" required>{accounts.map(account => <option key={account._id} value={account._id}>{account.label} · •••• {account.number.slice(-4)}</option>)}</select></label>
        <label>Destination bank<select name="bank" required defaultValue="test"><option value="" disabled>Choose a bank</option>{banks.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      </div>
      <div className="two-fields">
        <label>Account number<input name="number" defaultValue="1000000001" inputMode="numeric" pattern="[0-9]{10}" maxLength={10} placeholder="10 digits" required/></label>
        <label>Amount in naira<input name="amount" inputMode="decimal" placeholder="e.g. 500.00" required/></label>
      </div>
      <label>Transfer note<input name="description" minLength={3} maxLength={100} placeholder="What is this for?" required/></label>
      <button className="primary" disabled={!accounts.length || busy}>{busy ? 'Checking with Paystack…' : 'Review test transfer'}</button>
      <small className="form-caption"><ShieldCheck size={15}/> Choose Paystack Test Bank for the demo. Paystack checks the account; the transfer updates only your demo balance.</small>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {receipt && <p className="receipt">{receipt.mode === 'local-demo' ? 'Local demo transfer completed. No bank received money.' : 'Paystack test transfer confirmed. No real money moved.'}<br/>Reference: <code>{receipt.reference}</code></p>}
    {pending && <div className="external-confirm" role="region" aria-label="Review test transfer"><div className="external-confirm-card">
      <h3>Review test transfer</h3>
      <p>{money(pending.amountKobo)} from {accounts.find(account => account._id === pending.fromAccountId)?.label} to {pending.recipientName} at {banks.find(([code]) => code === pending.bankCode)?.[1]} · •••• {pending.accountNumber.slice(-4)}.</p>
      <p>Paystack Test Bank uses a local demo transfer after account lookup. Other banks attempt a test payout, with local simulation for Starter accounts. No real money moves.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="external-actions"><button className="secondary" disabled={busy} onClick={() => setPending(null)}>Edit</button><button className="primary" disabled={busy} onClick={confirm}>{busy ? 'Processing…' : 'Confirm test transfer'}</button></div>
    </div></div>}
  </section>;
}
