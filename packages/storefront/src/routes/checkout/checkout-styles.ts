export const CHECKOUT_STYLES = `
.checkout-layout{min-height:100vh;background:linear-gradient(to right,#2c2926 42%,#F7F2EA 42%)}
.checkout-columns{align-items:stretch}
.checkout-left,.checkout-right{min-height:100%}
.checkout-cta{display:block;width:100%;background:#141210;color:#FDFAF6;opacity:1;cursor:pointer;height:50px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;border-radius:3px;border:none;font-weight:500;transition:opacity 0.2s;position:relative}
.checkout-cta:hover{opacity:0.88}
.checkout-cta.checkout-cta-invalid{cursor:not-allowed;opacity:0.92}
.checkout-cta.checkout-cta-invalid:hover{opacity:0.92}
.checkout-cta-label{transition:color 0.18s ease}
.checkout-cta.checkout-cta-invalid:hover .checkout-cta-label{color:#fca5a5}
.checkout-cta-stop-icon{position:absolute;right:20px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity 0.18s ease;color:#fca5a5}
.checkout-cta.checkout-cta-invalid:hover .checkout-cta-stop-icon{opacity:1}
.checkout-cta-inline{position:relative}
.checkout-cta-tooltip{position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%) translateY(-4px);opacity:0;pointer-events:none;background:rgba(250,248,244,0.98);color:rgba(28,25,23,0.76);border:1px solid rgba(176,168,152,0.48);box-shadow:0 8px 20px rgba(28,25,23,0.12);font-size:11px;line-height:1;padding:7px 10px;border-radius:4px;white-space:nowrap;transition:all 0.18s ease;z-index:5}
.checkout-cta-tooltip::before{content:'';position:absolute;left:50%;top:-4px;transform:translateX(-50%) rotate(45deg);width:8px;height:8px;background:rgba(250,248,244,0.98);border-left:1px solid rgba(176,168,152,0.48);border-top:1px solid rgba(176,168,152,0.48)}
.checkout-cta-inline.checkout-cta-inline-invalid:hover .checkout-cta-tooltip{opacity:1;transform:translateX(-50%) translateY(0)}
.checkout-right input::placeholder,
.checkout-right select::placeholder,
.checkout-right textarea::placeholder {
  color: rgba(100, 85, 65, 0.42) !important;
}
.payment-placeholder{
  padding:2px 0;
  text-align:center;
  font-size:11px;
  color:rgba(100,85,65,0.4);
  letter-spacing:0.02em;
  line-height:1.6;
}
.sticky-cta-bar{
  display:none;
}
@media (max-width:767px){
  .checkout-layout{background:#F7F2EA}
  .checkout-left{background:#2c2926}
  .checkout-right{background:transparent}
  .checkout-right-inner{padding-bottom:90px!important}
  .checkout-cta-inline{display:none}
  .checkout-below-cta{display:none}
  .sticky-cta-bar{
    display:flex;
    position:fixed;
    bottom:0;left:0;right:0;
    z-index:40;
    background:#F7F2EA;
    border-top:1px solid rgba(184,115,51,0.18);
    padding:12px 16px calc(12px + env(safe-area-inset-bottom));
    align-items:center;
    gap:12px;
    box-shadow:0 -4px 20px rgba(0,0,0,0.06);
  }
  .sticky-cta-total{
    flex-shrink:0;
    text-align:left;
  }
  .sticky-cta-total-label{
    font-size:10px;
    letter-spacing:0.1em;
    text-transform:uppercase;
    color:rgba(100,85,65,0.5);
    line-height:1;
    margin-bottom:3px;
  }
  .sticky-cta-total-amount{
    font-size:16px;
    font-weight:500;
    color:#141210;
    line-height:1;
  }
  .sticky-cta-btn{
    flex:1;
    background:#141210;
    color:#FDFAF6;
    border:none;
    height:46px;
    border-radius:3px;
    font-size:11px;
    letter-spacing:0.14em;
    text-transform:uppercase;
    font-weight:500;
    cursor:pointer;
    transition:opacity 0.2s;
    opacity:1;
  }
  .sticky-cta-btn:active{opacity:0.85;}
}
` as const;
