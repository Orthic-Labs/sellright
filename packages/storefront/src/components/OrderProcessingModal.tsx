import { component$, useSignal, useVisibleTask$, type QRL } from '@qwik.dev/core';

export interface OrderProcessingModalProps {
  visible: boolean;
  onClose$?: QRL<() => void>;
}

export const OrderProcessingModal = component$<OrderProcessingModalProps>(({ visible, onClose$ }) => {
  const elapsed = useSignal(0);

  useVisibleTask$(({ track, cleanup }) => {
    track(() => visible);
    if (!visible) {
      elapsed.value = 0;
      return;
    }
    const interval = setInterval(() => {
      elapsed.value++;
    }, 1000);
    cleanup(() => clearInterval(interval));
  });

  if (!visible) return null;

  return (
    <div class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
      <div style={{
        background: '#141210',
        color: '#F7F2EA',
        padding: '48px 40px',
        borderRadius: '16px',
        width: '90%',
        maxWidth: '420px',
        textAlign: 'center',
        border: '1px solid rgba(184,115,51,0.2)',
      }}>
        <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'center' }}>
          <div class="dd-opm-spinner" />
        </div>

        <h2 style={{
          fontFamily: 'var(--font-display, "Cormorant Garamond", serif)',
          fontSize: '24px', fontWeight: '700', marginBottom: '8px',
          letterSpacing: '-0.01em',
        }}>
          {elapsed.value >= 30 ? 'Still Processing...' : 'Processing Your Order'}
        </h2>

        <p style={{
          fontFamily: 'var(--font-body, "IBM Plex Sans", sans-serif)',
          fontSize: '14px', color: 'rgba(247,242,234,0.5)',
          marginBottom: '28px',
        }}>
          {elapsed.value >= 30
            ? 'This is taking longer than usual. If you completed payment, check your email for an order confirmation.'
            : 'Please wait while we process your payment...'}
        </p>

        <div style={{
          height: '3px', borderRadius: '2px',
          background: 'rgba(184,115,51,0.15)', overflow: 'hidden',
        }}>
          <div class="dd-opm-bar" />
        </div>

        {elapsed.value >= 60 && onClose$ && (
          <button
            onClick$={onClose$}
            style={{
              fontFamily: 'var(--font-body, "IBM Plex Sans", sans-serif)',
              fontSize: '13px',
              color: '#B87333',
              background: 'transparent',
              border: '1px solid rgba(184,115,51,0.3)',
              borderRadius: '8px',
              padding: '10px 24px',
              marginTop: '24px',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        )}

        <p style={{
          fontFamily: 'var(--font-mono, "IBM Plex Mono", monospace)',
          fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'rgba(247,242,234,0.25)', marginTop: '24px',
        }}>
          Damned Designs
        </p>
      </div>
    </div>
  );
});
