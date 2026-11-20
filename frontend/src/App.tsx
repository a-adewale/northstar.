import { FormEvent, useEffect, useRef, useState } from 'react';
import ExternalTransferForm from './ExternalTransferForm';
import TransactionDetails from './TransactionDetails';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, CreditCard, Eye, EyeOff, Landmark, LayoutDashboard, LogOut, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Wallet, X } from 'lucide-react';

type User = { id: string; name: string; email: string; role: string };
type Account = { _id: string; label: string; number: string; balanceKobo: number; currency: string };
type Entry = { _id: string; accountId: string; reference: string; kind: 'credit' | 'debit'; amountKobo: number; description: string; createdAt: string };
type History = { items: Entry[]; total: number; page: number; pageSize: number };
type Transfer = { fromAccountId: string; toAccountId: string; amountKobo: number; description: string; key: string };
const currency = (kobo: number) => new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(kobo / 100);
const date = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(Array.isArray(body.message) ? body.message.join('. ') : body.message ?? 'The request could not be completed', res.status);
  return body;
}
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [register, setRegister] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [history, setHistory] = useState<History>({ items: [], total: 0, page: 1, pageSize: 8 });
  const [selected, setSelected] = useState('');
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('overview');
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [toast, setToast] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<Transfer | null>(null);
  const [reference, setReference] = useState('');
  const [admin, setAdmin] = useState<{ customers: number; accounts: number; transfers: number } | null>(null);
  const [payAccount, setPayAccount] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const errorMessage = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401 && user) { setUser(null); setAccounts([]); setPending(null); setNotice('Your session ended. Please sign in again.'); }
    setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
  };
  useEffect(() => {
    mounted.current = true;
    api<User>('/auth/me').then(u => mounted.current && setUser(u)).catch(e => { if (e.status !== 401 && mounted.current) errorMessage(e); }).finally(() => mounted.current && setChecking(false));
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!user) return;
    let active = true;
    api<Account[]>('/accounts').then(a => { if (active) setAccounts(a); }).catch(e => active && errorMessage(e));
    if (user.role === 'admin') api<{ customers: number; accounts: number; transfers: number }>('/admin/summary').then(a => active && setAdmin(a)).catch(e => active && errorMessage(e));
    return () => { active = false; };
  }, [user, revision]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ kind, search, page: String(page) });
      if (selected) params.set('accountId', selected);
      api<History>(`/transactions?${params}`, { signal: controller.signal }).then(setHistory).catch(e => { if (e.name !== 'AbortError') errorMessage(e); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [user, selected, kind, search, page, revision]);
  useEffect(() => { if (pending) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [pending]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!user) return;
    const reference = new URLSearchParams(window.location.search).get('payment');
    if (!reference) return;
    window.history.replaceState({}, '', window.location.pathname);
    setPayBusy(true);
    api<{ status: string; amountKobo: number }>('/payments/verify', { method: 'POST', body: JSON.stringify({ reference }) })
      .then(result => { const message = result.status === 'paid' ? `Paystack test payment confirmed: ${currency(result.amountKobo)} credited.` : 'Payment is still pending. No balance was credited.'; setNotice(message); setToast(message); if (result.status === 'paid') setRevision(r => r + 1); })
      .catch(errorMessage).finally(() => setPayBusy(false));
  }, [user]);

  async function startPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setPayBusy(true);
    if (!/^\d+(\.\d{1,2})?$/.test(payAmount)) { setError('Enter an amount with up to two decimal places.'); setPayBusy(false); return; }
    const [whole, fraction = ''] = payAmount.split('.');
    const amountKobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    try {
      const result = await api<{ authorizationUrl: string }>('/payments/initialize', { method: 'POST', body: JSON.stringify({ accountId: payAccount || accounts[0]?._id, amountKobo }) });
      window.location.assign(result.authorizationUrl);
    } catch (error) { errorMessage(error); setPayBusy(false); }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const data = new FormData(event.currentTarget);
    const credentials = { email: String(data.get('email')), password: String(data.get('password')) };
    try {
      if (register) await api('/auth/register', { method: 'POST', body: JSON.stringify({ ...credentials, name: String(data.get('name')) }) });
      const u = await api<User>('/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
      setSelected(''); setPage(1); setKind('all'); setSearch(''); setUser(u);
    } catch (e) { errorMessage(e); } finally { setBusy(false); }
  }
  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); setUser(null); setAccounts([]); setPending(null); setError(''); setReference(''); } catch (e) { errorMessage(e); }
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setReference('');
    const data = new FormData(event.currentTarget);
    const raw = String(data.get('amount'));
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) { setError('Enter an amount with up to two decimal places.'); return; }
    const [whole, fraction = ''] = raw.split('.');
    const amountKobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const fromAccountId = String(data.get('from'));
    const toAccountId = String(data.get('to'));
    if (fromAccountId === toAccountId) { setError('Choose different source and destination accounts.'); return; }
    if (!Number.isSafeInteger(amountKobo) || amountKobo < 100 || amountKobo > 100000000) { setError('Enter an amount between ₦1 and ₦1,000,000.'); return; }
    if (amountKobo > (accounts.find(a => a._id === fromAccountId)?.balanceKobo ?? 0)) { setError('That amount is greater than your available balance.'); return; }
    setPending({ fromAccountId, toAccountId, amountKobo, description: String(data.get('description')).trim(), key: crypto.randomUUID() });
  }
  async function confirm() {
    if (!pending || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const result = await api<{ reference: string }>('/transfers', { method: 'POST', body: JSON.stringify(pending) });
      setReference(result.reference); setNotice('Transfer complete. Both account balances have been updated.'); setToast(`${currency(pending.amountKobo)} moved between your accounts.`); setPending(null); formRef.current?.reset(); setPage(1); setRevision(r => r + 1);
    } catch (e) { errorMessage(e); } finally { locked.current = false; setBusy(false); }
  }

  if (checking) return <div className="screen-center"><Landmark size={34}/><p>Opening your workspace…</p></div>;
  if (!user) return <main className="auth-layout"><section className="auth-story"><a className="brand" href="#"><span className="brand-icon"><Landmark/></span> northstar<span className="dot">.</span></a><div><span className="overline">A LITTLE MORE CLARITY</span><h1>Your money.<br/>Your next chapter.</h1><p>A calmer place to manage your everyday spending and save for what comes next.</p><div className="auth-art"><div className="orbit one"/><div className="orbit two"/><div className="mini-card"><Wallet/><span>Room to grow</span><strong>One step at a time.</strong><div className="spark-bars">{[22,35,28,48,56,70,86].map((n,i)=><i key={i} style={{height:n}}/>)}</div></div></div></div><span className="sample-label">Portfolio application · Simulated funds</span></section><section className="auth-form"><div className="form-inner"><span className="overline">YOUR PERSONAL WORKSPACE</span><h2>{register ? 'A fresh start.' : 'Welcome back.'}</h2><p>{register ? 'Create an account to explore Northstar.' : 'Sign in and pick up where you left off.'}</p><form onSubmit={authenticate} key={String(register)}>{register && <label>Full name<input name="name" autoComplete="name" minLength={2} maxLength={80} required placeholder="Your full name"/></label>}<label>Email address<input name="email" type="email" autoComplete="username" required defaultValue={register ? '' : 'ada@example.com'}/></label><label>Password<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 10 : 1} maxLength={72} required defaultValue={register ? '' : 'Northstar123!'}/></label>{register && <small>Use at least 10 characters. New accounts start with zero balance.</small>}{error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}<button className="primary" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button></form><button className="text-button auth-switch" onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</button><div className="sample-note"><ShieldCheck size={19}/><span>The sample login is prefilled.<br/>All balances are simulated.</span></div></div></section></main>;
  const total = accounts.reduce((sum,a)=>sum+a.balanceKobo,0);
  const savings = accounts.find(a=>a.label==='Savings account');
  const balance = (n: number) => hidden ? '••••••' : currency(n);
  const firstName = user.name.split(' ')[0];
  return <div className="workspace"><aside className="sidebar"><a className="brand" href="#" aria-label="Northstar home" onClick={()=>setTab('overview')}><span className="brand-icon"><Landmark/></span><span className="brand-word">northstar<span className="dot">.</span></span></a><span className="nav-label">YOUR WORKSPACE</span><nav>{[{id:'overview',label:'Overview',icon:LayoutDashboard},{id:'accounts',label:'Accounts',icon:Wallet},{id:'activity',label:'Activity',icon:CreditCard}].map(item=><button key={item.id} className={`nav-item ${tab===item.id?'active':''}`} onClick={()=>setTab(item.id)} title={item.label}><item.icon size={19}/><span>{item.label}</span></button>)}</nav><div className="sidebar-footer"><div className="security-note"><ShieldCheck/><strong>Made for your peace of mind.</strong><p>Your workspace is personal. Keep your sign-in details private.</p></div><button className="nav-item" onClick={logout} title="Sign out"><LogOut size={18}/><span>Sign out</span></button><span className="sidebar-caption">NORTHSTAR · PORTFOLIO EDITION</span></div></aside><div className="main"><header className="topbar"><div><span>Workspace</span><i>/</i><strong>{tab==='overview'?'Overview':tab==='accounts'?'Accounts':'Activity'}</strong></div><div className="profile"><span className="sample-chip">Sample account environment</span><span className="avatar">{user.name.split(' ').slice(0,2).map(n=>n[0]).join('')}</span><span>{user.name}</span></div></header><main className="content"><section className="page-heading"><div><span className="overline">{new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}</span><h1>{tab==='overview'?`Hello, ${firstName}.`:tab==='accounts'?'A place for every plan.':'Your money in motion.'}</h1><p>{tab==='activity'?'Browse and filter your account transactions.':'A clear view of your money, and room for what’s next.'}</p></div><button className="secondary" onClick={()=>{setTab('overview'); setTimeout(()=>formRef.current?.querySelector('select')?.focus(),0);}}><Plus size={18}/> Make a transfer</button></section>{error && <div className="banner error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button></div>}{notice && <div className="banner notice" role="status"><Check size={18}/><span>{notice}</span><button aria-label="Dismiss message" onClick={()=>setNotice('')}><X size={16}/></button></div>}
    {tab!=='activity' && <><section className="summary"><article className="balance-card"><div className="balance-top"><span>Total available balance</span><button aria-label={hidden?'Show balances':'Hide balances'} onClick={()=>setHidden(!hidden)}>{hidden?<Eye size={18}/>:<EyeOff size={18}/>}</button></div><strong className="large-balance">{balance(total)}</strong><div className="balance-bottom"><span>{accounts.length} personal accounts</span><span>NGN · Nigerian naira</span></div><div className="balance-ring"/></article><article className="summary-card"><span className="square-icon"><Wallet size={21}/></span><span>Everyday balance</span><strong>{balance(accounts.find(a=>a.label==='Everyday account')?.balanceKobo??0)}</strong><small>Ready for your next move</small></article><article className="summary-card"><span className="square-icon lavender"><Sparkles size={21}/></span><span>Set aside in savings</span><strong>{balance(savings?.balanceKobo??0)}</strong><small>{total ? Math.round((savings?.balanceKobo??0)/total*100) : 0}% of your total balance</small></article></section><section className="middle-grid"><article className="panel"><div className="panel-title"><div><h2>Your accounts</h2><p>Everyday essentials. Future possibilities.</p></div><span className="count-chip">{accounts.length}</span></div><div className="accounts-list">{accounts.map((a,i)=><button key={a._id} className="account-row" onClick={()=>{setSelected(a._id);setPage(1);setTab('activity');}}><span className={`square-icon ${i?'lavender':''}`}><Landmark size={22}/></span><span className="account-title"><strong>{a.label}</strong><small>•••• {a.number.slice(-4)} · NGN</small></span><strong>{balance(a.balanceKobo)}</strong><ChevronRight size={17}/></button>)}</div><div className="savings-note"><div><span className="overline">SMALL STEPS, BIG POSSIBILITIES</span><h3>A little today. More tomorrow.</h3><p>Move money into savings whenever it works for you.</p></div><div className="plant"><span/><span/><span/><i/></div></div></article><article className="panel transfer-panel"><div className="panel-title"><div><h2>Quick transfer</h2><p>Between your personal accounts.</p></div><span className="square-icon"><RefreshCw size={19}/></span></div><form ref={formRef} onSubmit={review}><div className="two-fields"><label>From<select name="from" required>{accounts.map(a=><option key={a._id} value={a._id}>{a.label}</option>)}</select></label><label>To<select name="to" key={accounts.map(a=>a._id).join()} defaultValue={accounts[1]?._id} required>{accounts.map(a=><option key={a._id} value={a._id}>{a.label}</option>)}</select></label></div><label>Amount<div className="amount-input"><span>₦</span><input name="amount" inputMode="decimal" placeholder="0.00" required aria-label="Amount in naira"/></div></label><label>Transfer note<input name="description" required minLength={3} maxLength={100} placeholder="e.g. A little extra for savings"/></label><button className="primary" disabled={accounts.length<2}>Review transfer</button><span className="form-caption"><ShieldCheck size={15}/> Your balances update together.</span></form>{reference && <p className="receipt">Receipt: <code>{reference}</code></p>}</article></section></>}
    {tab!=='activity' && <ExternalTransferForm accounts={accounts} onCompleted={(ref,mode)=>{const message=mode==='local-demo'?'Local demo transfer complete. Your demo balance was updated; no bank received money.':`Paystack test transfer confirmed: ${ref}. No real money moved.`;setNotice(message);setToast(message);setRevision(r=>r+1);}}/>}
    {tab!=='activity' && <section className="panel payment-panel"><div className="panel-title"><div><h2>Add money from another bank</h2><p>Use Paystack test checkout to fund your demo account. Choose a bank payment option there when available.</p></div><span className="square-icon"><CreditCard size={20}/></span></div><form onSubmit={startPayment} className="payment-form"><label>Credit account<select value={payAccount} onChange={e=>setPayAccount(e.target.value)} required><option value="" disabled>Choose an account</option>{accounts.map(a=><option key={a._id} value={a._id}>{a.label} · •••• {a.number.slice(-4)}</option>)}</select></label><label>Amount in naira<input inputMode="decimal" placeholder="e.g. 500.00" value={payAmount} onChange={e=>setPayAmount(e.target.value)} required/></label><button className="primary" disabled={payBusy || !accounts.length}>{payBusy?'Checking payment…':'Continue to test checkout'}</button></form><small className="payment-note">Paystack test mode. Your Northstar account numbers cannot receive real bank transfers.</small></section>}
    {tab!=='accounts' && <section className="panel activity"><div className="panel-title"><div><h2>{tab==='activity'?'Account activity':'Recent activity'}</h2><p>Every movement, in one place.</p></div><button className="text-button" onClick={()=>setRevision(r=>r+1)} disabled={loading}><RefreshCw size={15} className={loading?'spinning':''}/> Refresh</button></div><div className="filters"><label className="search"><Search size={17}/><input aria-label="Search descriptions" placeholder="Search transactions" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label><select aria-label="Filter by account" value={selected} onChange={e=>{setSelected(e.target.value);setPage(1);}}><option value="">All accounts</option>{accounts.map(a=><option key={a._id} value={a._id}>{a.label}</option>)}</select><select aria-label="Filter by type" value={kind} onChange={e=>{setKind(e.target.value);setPage(1);}}><option value="all">All transactions</option><option value="credit">Money in</option><option value="debit">Money out</option></select></div><div className="table-scroll" aria-busy={loading}><table><thead><tr><th>Transaction</th><th>Account</th><th>Date</th><th>Status</th><th className="numeric">Amount</th></tr></thead><tbody>{history.items.map(t=><tr key={t._id}><td><button className="transaction-detail-trigger" onClick={()=>setDetailId(t._id)} aria-label={`View details for ${t.description}`}><div className="transaction"><span className={`transaction-icon ${t.kind}`}>{t.kind==='credit'?<ArrowDownLeft size={19}/>:<ArrowUpRight size={19}/>}</span><span><strong>{t.description}</strong><small title={t.reference}>{t.kind==='credit'?'Money received':'Money sent'} · {t.reference.slice(0,11)}</small></span></div><span className="detail-affordance">View details <ChevronRight size={14}/></span></button></td><td>{accounts.find(a=>a._id===t.accountId)?.label??'Account'}</td><td>{date(t.createdAt)}</td><td><span className="completed">Completed</span></td><td className={`numeric ${t.kind==='credit'?'positive':''}`}>{hidden?'••••••':`${t.kind==='credit'?'+':'−'}${currency(t.amountKobo)}`}</td></tr>)}</tbody></table>{!history.items.length && <div className="empty"><CreditCard size={27}/><h3>{loading?'Loading activity…':'No transactions here yet.'}</h3><p>{search || kind!=='all'?'Try another search or filter.':'Your completed transfers will appear here.'}</p></div>}</div><div className="table-footer"><span>{history.total} transaction{history.total!==1?'s':''} · Page {page} of {Math.max(1,Math.ceil(history.total/8))}</span><div><button aria-label="Previous page" className="icon-button" disabled={page===1 || loading} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={18}/></button><button aria-label="Next page" className="icon-button" disabled={page*8>=history.total || loading} onClick={()=>setPage(p=>p+1)}><ChevronRight size={18}/></button></div></div></section>}
    {admin && <section className="panel admin"><h2>Operations overview</h2><p>{admin.customers} customers · {admin.accounts} accounts · {admin.transfers} completed transfers</p></section>}<footer><span>Northstar · A banking portfolio project by Adewale Adeogun</span><span>Simulated funds only</span></footer></main></div>{toast && <div className="transfer-toast" role="status" aria-live="polite"><Check size={18}/><span>{toast}</span><button aria-label="Dismiss notification" onClick={()=>setToast('')}><X size={17}/></button></div>}<dialog ref={dialogRef} onCancel={e=>{if(busy)e.preventDefault();else setPending(null);}}><div className="dialog-heading"><span className="square-icon"><RefreshCw size={22}/></span><button className="icon-button" aria-label="Close confirmation" disabled={busy} onClick={()=>setPending(null)}><X size={20}/></button></div><h2>Everything look right?</h2><p>Confirm your transfer before moving the funds.</p>{pending && <><strong className="confirm-amount">{currency(pending.amountKobo)}</strong><dl><dt>From</dt><dd>{accounts.find(a=>a._id===pending.fromAccountId)?.label}</dd><dt>To</dt><dd>{accounts.find(a=>a._id===pending.toAccountId)?.label}</dd><dt>Note</dt><dd>{pending.description}</dd><dt>Fee</dt><dd>₦0.00</dd></dl>{error && <p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy} onClick={confirm}>{busy?'Processing transfer…':'Confirm transfer'}</button><button className="text-button back-button" disabled={busy} onClick={()=>setPending(null)}>Back to edit</button></>}</dialog><TransactionDetails id={detailId} onClose={()=>setDetailId(null)}/></div>;
}
