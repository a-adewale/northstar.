import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, X } from 'lucide-react';

type Detail = {
  id: string; reference: string; kind: 'credit' | 'debit'; amountKobo: number; description: string;
  createdAt: string; status: string; currency: string; type: string;
  account: { label: string; last4: string } | null;
  counterparty: { name: string; bank?: string; last4: string } | null;
  mode: 'internal' | 'paystack-test' | 'local-demo';
};
const money = (kobo: number) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(kobo / 100);

export default function TransactionDetails({ id, onClose }: { id: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) { dialog.current?.close(); setDetail(null); return; }
    if (!dialog.current?.open) dialog.current?.showModal();
    const controller = new AbortController();
    setDetail(null); setError(''); setLoading(true);
    fetch(`/api/transactions/${encodeURIComponent(id)}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? 'Transaction details are unavailable.');
        return result as Detail;
      })
      .then(setDetail)
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Transaction details are unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);

  return <dialog ref={dialog} className="transaction-dialog" onCancel={onClose} onClose={onClose} aria-labelledby="transaction-dialog-title">
    <div className="dialog-heading"><span className="square-icon">{detail?.kind === 'credit' ? <ArrowDownLeft size={21}/> : <ArrowUpRight size={21}/>}</span><button className="icon-button" aria-label="Close transaction details" onClick={onClose}><X size={19}/></button></div>
    <h2 id="transaction-dialog-title">Transaction details</h2>
    {loading && <p>Loading details…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {detail && <>
      <span className="detail-type">{detail.type}</span>
      <strong className="confirm-amount">{detail.kind === 'credit' ? '+' : '−'}{money(detail.amountKobo)}</strong>
      <dl className="detail-grid">
        <dt>Status</dt><dd>{detail.mode === 'local-demo' ? 'Local demo completed' : detail.mode === 'paystack-test' ? 'Paystack test completed' : 'Completed'}</dd>
        <dt>Account</dt><dd>{detail.account ? `${detail.account.label} · •••• ${detail.account.last4}` : 'Account'}</dd>
        {detail.counterparty && <><dt>{detail.kind === 'credit' ? 'From' : 'To'}</dt><dd>{detail.counterparty.name}{detail.counterparty.bank ? ` · ${detail.counterparty.bank}` : ''} · •••• {detail.counterparty.last4}</dd></>}
        <dt>Date and time</dt><dd>{new Date(detail.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        <dt>Note</dt><dd>{detail.description}</dd>
        <dt>Reference</dt><dd><code>{detail.reference}</code></dd>
      </dl>
      {detail.mode !== 'internal' && <p className="detail-disclaimer">{detail.mode === 'local-demo' ? 'This transfer was saved in the local demo ledger. No bank received money.' : 'Paystack test mode. No real money moved.'}</p>}
    </>}
  </dialog>;
}
