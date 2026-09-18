const $ = (id) => document.getElementById(id);
const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100);
let cart;
let busy = false;
const imageClasses = { 'studio-notebook': 'notebook', 'everyday-tote': 'tote', 'stoneware-cup': 'cup', 'desk-tray': 'tray' };
const descriptions = { 'studio-notebook': 'A place for your next idea.', 'everyday-tote': 'Ready for the everyday.', 'stoneware-cup': 'A little pause, well made.', 'desk-tray': 'Everything in its place.' };

async function request(path, options = {}) {
  const response = await fetch('/v1/shop/' + path, {
    ...options, headers: { 'content-type': 'application/json' },
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 409 && body.cart) { cart = body.cart; renderCart(); }
    throw new Error(body.error ?? 'The demo is temporarily unavailable.');
  }
  return body;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function error(message) { $('error').hidden = !message; $('error').textContent = message ?? ''; }
async function action(run) {
  if (busy) return;
  busy = true; error();
  document.querySelectorAll('.add, .quantity button, .remove').forEach(button => { button.disabled = true; });
  try { await run(); }
  catch (e) { error(e.message); }
  finally {
    busy = false;
    document.querySelectorAll('.add, .quantity button, .remove').forEach(button => { button.disabled = false; });
  }
}
async function setQuantity(sku, quantity) {
  if (!cart) {
    cart = await request('cart', { method: 'POST', body: JSON.stringify({ items: [{ sku, quantity }] }) });
    localStorage.setItem('sellright-demo-cart', cart.token);
  } else {
    cart = await request('cart/' + cart.token + '/lines', {
      method: 'PATCH', body: JSON.stringify({ lines: [{ sku, quantity }], expectedRevision: cart.revision }),
    });
  }
  renderCart();
}
function renderCart() {
  $('cart-lines').replaceChildren();
  const lines = cart?.lines ?? [];
  $('count').textContent = lines.reduce((count, line) => count + line.quantity, 0);
  $('subtotal').textContent = money(cart?.subtotal ?? 0);
  if (!lines.length) $('cart-lines').append(element('p', 'Your cart is empty.', 'empty'));
  for (const line of lines) {
    const row = element('div', undefined, 'cart-line');
    row.append(element('strong', line.name), element('span', money(line.lineTotal)));
    const quantity = element('div', undefined, 'quantity');
    for (const [label, value] of [['-', line.quantity - 1], ['+', line.quantity + 1]]) {
      const button = element('button', label);
      button.setAttribute('aria-label', (label === '+' ? 'Increase ' : 'Decrease ') + line.name);
      button.disabled = value > 10 || busy;
      button.addEventListener('click', () => action(() => setQuantity(line.sku, value)));
      quantity.append(button);
      if (label === '-') quantity.append(element('span', String(line.quantity)));
    }
    const remove = element('button', 'Remove', 'remove');
    remove.addEventListener('click', () => action(() => setQuantity(line.sku, 0)));
    row.append(quantity, remove); $('cart-lines').append(row);
  }
}
async function load() {
  try {
    const catalog = await request('catalog/products');
    $('products').replaceChildren();
    $('product-count').textContent = catalog.total + ' products';
    for (const product of catalog.items) {
      const detail = await request('catalog/products/' + encodeURIComponent(product.slug));
      const card = element('article', undefined, 'product');
      const image = element('div', undefined, 'photo ' + imageClasses[product.slug]);
      image.setAttribute('role', 'img'); image.setAttribute('aria-label', product.name + ' synthetic sample');
      const info = element('div', undefined, 'product-info');
      info.append(element('h2', product.name), element('span', money(product.minPrice), 'price'));
      const add = element('button', 'Add to cart', 'add');
      add.addEventListener('click', () => action(async () => {
        const sku = detail.variants[0].sku;
        const quantity = (cart?.lines.find(line => line.sku === sku)?.quantity ?? 0) + 1;
        if (quantity > 10) throw new Error('Demo limit: 10 of each item.');
        await setQuantity(sku, quantity);
      }));
      card.append(image, info, element('p', descriptions[product.slug]), add);
      $('products').append(card);
    }
    const token = localStorage.getItem('sellright-demo-cart');
    if (token && /^[0-9a-f-]{36}$/.test(token)) {
      try { cart = await request('cart/' + token); }
      catch { localStorage.removeItem('sellright-demo-cart'); }
    }
    renderCart();
  } catch (e) { error(e.message); $('products').replaceChildren(); }
}
function showCart(open) { $('cart').classList.toggle('open', open); $('cart-toggle').setAttribute('aria-expanded', String(open)); }
$('cart-toggle').addEventListener('click', () => showCart(!$('cart').classList.contains('open')));
$('cart-close').addEventListener('click', () => showCart(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') showCart(false); });
load();
