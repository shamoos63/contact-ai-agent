import { useEffect, useState } from 'react';
import { ImagePlus, Trash2, Pencil } from 'lucide-react';
import { api, getSocket } from '../api.js';
import { PageHeader, Pill } from '../components/ui.jsx';

const EMPTY = { name: '', price: '', description: '', in_stock: true };

// Products with prices and photos. The AI answers from them, and sends the photo when it talks about one.
export default function Catalog() {
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sendPhotos, setSendPhotos] = useState(true);
  const [q, setQ] = useState('');

  const load = () => api('/products').then(setProducts).catch((err) => setError(err.message));
  useEffect(() => {
    load();
    api('/settings').then((s) => setSendPhotos(s.catalog?.send_photos !== false)).catch(() => {});
    const socket = getSocket();
    socket.on('products', load);
    return () => socket.off('products', load);
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('name', form.name);
      fd.append('price', form.price || '');
      fd.append('description', form.description || '');
      fd.append('in_stock', form.in_stock ? '1' : '0');
      if (file) fd.append('image', file);
      await api(form.id ? `/products/${form.id}` : '/products', { method: form.id ? 'PUT' : 'POST', form: fd });
      setForm(EMPTY);
      setFile(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = (p) => confirm(`Delete "${p.name}"?`) && api(`/products/${p.id}`, { method: 'DELETE' }).then(load);
  const toggleStock = async (p) => {
    const fd = new FormData();
    for (const k of ['name', 'price', 'description']) fd.append(k, p[k] || '');
    fd.append('in_stock', p.in_stock ? '0' : '1');
    await api(`/products/${p.id}`, { method: 'PUT', form: fd }).catch((err) => setError(err.message));
    load();
  };
  const setPhotos = async (on) => {
    setSendPhotos(on);
    await api('/settings', { method: 'PUT', body: { catalog: { send_photos: on } } }).catch((err) => setError(err.message));
  };
  const shown = products.filter((p) => !q || `${p.name} ${p.description || ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <PageHeader title="Catalog" subtitle="Your products, prices and photos. The AI answers from them and sends the photo when it talks about a product." />
      <form className="card" onSubmit={save}>
        <h3>{form.id ? `Edit ${form.name}` : 'Add a product'}</h3>
        <div className="row">
          <label className="grow">Name<input dir="auto" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="iPhone 15 Pro 256GB" /></label>
          <label>Price<input dir="auto" value={form.price || ''} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="3,999 AED" /></label>
        </div>
        <label>Description<textarea dir="auto" rows={3} value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Colours, condition, warranty, what's in the box…" /></label>
        <div className="row">
          <label className="file-pick"><ImagePlus size={15} /> {file ? file.name : form.image ? 'Change photo' : 'Add a photo'}
            <input type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files[0] || null)} />
          </label>
          <label className="switch"><input type="checkbox" checked={!!form.in_stock} onChange={(e) => setForm({ ...form, in_stock: e.target.checked })} /><span>In stock</span></label>
          <div className="grow" />
          {form.id && <button type="button" onClick={() => { setForm(EMPTY); setFile(null); }}>Cancel</button>}
          <button className="primary" disabled={busy}>{busy ? 'Saving…' : form.id ? 'Save' : 'Add'}</button>
        </div>
        {error && <div className="error small">{error}</div>}
      </form>
      <div className="card">
        <div className="row">
          <h3 className="grow">Products ({products.length})</h3>
          <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="switch"><input type="checkbox" checked={sendPhotos} onChange={(e) => setPhotos(e.target.checked)} /><span>Send the product photo when the AI talks about a product (WhatsApp, Telegram)</span></label>
        {!shown.length && <p className="muted">No products yet. Add your best sellers first: customers ask about them most.</p>}
        <div className="products">
          {shown.map((p) => (
            <div key={p.id} className="product">
              {p.image ? <img src={`/api/media/${p.image}`} alt="" loading="lazy" /> : <div className="no-photo muted small">No photo</div>}
              <div className="grow">
                <strong dir="auto">{p.name}</strong>
                <div className="small" dir="auto">{p.price || <span className="muted">No price</span>}</div>
                {p.description && <div className="small muted clamp" dir="auto">{p.description}</div>}
              </div>
              <div className="row small">
                <button className="link" onClick={() => toggleStock(p)} title="Change stock">{p.in_stock ? <Pill tone="ok">In stock</Pill> : <Pill tone="warn">Out of stock</Pill>}</button>
                <button className="icon" title="Edit" onClick={() => { setForm({ ...p, in_stock: !!p.in_stock }); setFile(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Pencil size={15} /></button>
                <button className="icon" title="Delete" onClick={() => remove(p)}><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
