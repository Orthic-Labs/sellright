import { component$, useSignal, useStore, useVisibleTask$, noSerialize, type NoSerialize, type QRL } from '@qwik.dev/core';
import type { VerificationProgram } from './types';

interface SheerIdServiceProps {
  program: VerificationProgram;
  customerId: string | null;
  onVerificationSuccess$?: QRL<(response: any) => void>;
  onVerificationError$?: QRL<(error: string) => void>;
}

interface SheerIdForm {
  setOptions: (options: { logLevel?: string }) => void;
  setViewModel: (viewModel: { metadata?: Record<string, any> }) => void;
  on: (event: string, callback: (data: any) => void) => () => void;
  once: (event: string, callback: (data: any) => void) => () => void;
}

/**
 * SheerID Service Component using official JavaScript Library
 * Follows Qwik patterns for third-party library integration
 */
export const SheerIdService = component$<SheerIdServiceProps>(({
  program,
  customerId,
  onVerificationSuccess$,
  onVerificationError$
}) => {
  const containerRef = useSignal<HTMLDivElement>();
  const isLoading = useSignal(true);
  const error = useSignal<string>();
  const verificationStatus = useSignal<'ready' | 'success' | 'failed' | null>(null);
  const verificationResponse = useSignal<any>();

  // Store for non-serializable SheerID form instance
  const store = useStore<{
    sheerIdForm: NoSerialize<SheerIdForm>
  }>({
    sheerIdForm: undefined,
  });

  useVisibleTask$(({ track }) => {
    track(() => containerRef.value);
    track(() => program);
    track(() => customerId);

    if (!containerRef.value) return;

    const initializeSheerID = async () => {
      console.log('SheerIdService: Initializing for program:', program.id);
      try {
        // Dynamically load the SheerID JS SDK if not already present
        if (!(window as any).sheerId) {
          await new Promise<void>((resolve, reject) => {
            const existing = document.querySelector('script[src*="services.sheerid.com/jsapi"]');
            if (existing) {
              // Script tag exists but SDK not ready yet — poll briefly
              let polls = 0;
              const interval = setInterval(() => {
                if ((window as any).sheerId) { clearInterval(interval); resolve(); }
                else if (++polls > 50) { clearInterval(interval); reject(new Error('SheerID SDK timeout')); }
              }, 100);
              return;
            }
            const script = document.createElement('script');
            script.src = 'https://services.sheerid.com/jsapi/2.0/src/sheerid.js';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load SheerID script'));
            document.head.appendChild(script);
          });
        }

        if (!(window as any).sheerId) {
          throw new Error('SheerID library failed to initialize');
        }

        const sheerId = (window as any).sheerId;
        console.log('SheerIdService: SheerID library loaded successfully');
        
        // Create program URL
        const programUrl = `https://services.sheerid.com/verify/${program.sheerIdProgramId}/`;
        console.log('SheerIdService: Loading inline iframe for URL:', programUrl);

        // Load inline into our container — NOT as a modal (which would create a conflicting overlay)
        const myForm = sheerId.loadInlineIframe(containerRef.value!, programUrl);

        // Store the form instance using noSerialize (following Qwik patterns)
        store.sheerIdForm = noSerialize(myForm);

        // Configure options
        myForm.setOptions({
          logLevel: 'info'
        });

        // Set up event handlers (using signals instead of callbacks)
        myForm.on('ON_VERIFICATION_READY', () => {
          console.log('SheerID event: ON_VERIFICATION_READY');
          isLoading.value = false;
          verificationStatus.value = 'ready';
        });

        myForm.on('ON_VERIFICATION_SUCCESS', async (response: any) => {
          verificationStatus.value = 'success';
          verificationResponse.value = response;
          if (onVerificationSuccess$) {
            await onVerificationSuccess$(response);
          }
        });

        myForm.on('ON_VERIFICATION_STEP_CHANGE', async (response: any) => {
          // Handle error states
          if (response.currentStep === 'error') {
            const errorMessage = response.errors?.[0]?.message || 'Verification failed';
            error.value = errorMessage;
            verificationStatus.value = 'failed';
            isLoading.value = false; // Ensure loading spinner is hidden on error
            if (onVerificationError$) {
              await onVerificationError$(errorMessage);
            }
          }
        });

        console.log('SheerID form initialized successfully');

      } catch (err) {
        console.error('Failed to initialize SheerID:', err);
        error.value = err instanceof Error ? err.message : 'Failed to load verification form';
        isLoading.value = false;
        verificationStatus.value = 'failed';
      }
    };

    initializeSheerID();
  });

  return (
    <div class="sheerid-service">
      {isLoading.value && (
        <div class="flex items-center justify-center p-8">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <span class="ml-3 text-gray-600">Loading verification form...</span>
        </div>
      )}
      
      {error.value && (
        <div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
              </svg>
            </div>
            <div class="ml-3">
              <h3 class="text-sm font-medium text-red-800">Verification Error</h3>
              <p class="mt-1 text-sm text-red-700">{error.value}</p>
              <p class="mt-2 text-xs text-red-600">
                Please try again or contact support if the problem persists.
              </p>
            </div>
          </div>
        </div>
      )}
      
      <div
        ref={containerRef}
        class="sheerid-container"
        style={{ minHeight: '500px', width: '100%' }}
      />
    </div>
  );
});

// Global type declaration for SheerID library
declare global {
  interface Window {
    sheerId: {
      loadInlineIframe: (container: HTMLElement, programUrl: string) => SheerIdForm;
      loadInModal: (programUrl: string) => SheerIdForm;
    };
  }
}
