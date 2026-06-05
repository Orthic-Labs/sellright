import { component$, useSignal, $, useContext } from '@qwik.dev/core';
import {
  VERIFICATION_PROGRAMS,
  type VerificationProgram,
  type VerificationModalProps
} from './types';
import { useLoginModalActions } from '~/contexts/LoginModalContext';
import { APP_STATE, CUSTOMER_NOT_DEFINED_ID } from '~/constants';
import SheerIdModal from './SheerIdModal';

export default component$<VerificationModalProps>(({ isOpen, onClose$ }) => {
  const appState = useContext(APP_STATE);
  const error = useSignal<string>('');
  const selectedProgram = useSignal<VerificationProgram | null>(null);
  const showSheerIdModal = useSignal<boolean>(false);
  const { openLoginModal } = useLoginModalActions();

  // Get current customer ID from app state (this is always up-to-date)
  const currentCustomerId = appState.customer?.id !== CUSTOMER_NOT_DEFINED_ID ? appState.customer?.id : null;

  const closeModal = $(() => {
    error.value = '';
  });

  const closeSheerIdModal = $(() => {
    showSheerIdModal.value = false;
    selectedProgram.value = null;
  });



  const selectProgram = $(async (program: VerificationProgram) => {
    if (!currentCustomerId) {
      // Open login modal
      await openLoginModal();
      return;
    }

    // Show the SheerID modal with the selected program
    selectedProgram.value = program;
    showSheerIdModal.value = true;
  });

  if (!isOpen) return null;

  return (
    <div
      style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.82);backdrop-filter:blur(4px);padding:1rem;overflow-y:auto;"
      onClick$={$(async (e) => {
        if (e.target === e.currentTarget) {
          closeModal();
          await onClose$();
        }
      })}
    >
      <div class="relative w-full max-w-4xl mx-auto my-8">
        <div class="bg-gray-50 rounded-lg shadow-xl overflow-hidden animate-scale-in max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div class="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200">
            <h2 class="text-xl sm:text-2xl font-bold text-gray-900">
              Exclusive Discounts
            </h2>
            <button
              onClick$={$(async () => {
                closeModal();
                await onClose$();
              })}
              class="text-gray-400 hover:text-gray-600 focus:outline-none transition-colors"
              aria-label="Close modal"
            >
              <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div class="p-4 sm:p-6">
            {error.value && (
              <div class="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
                <p class="text-red-800">{error.value}</p>
              </div>
            )}

            {/* Program Selection */}
            <div class="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {VERIFICATION_PROGRAMS.map((program) => (
                <button
                  key={program.id}
                  data-program-id={program.id}
                  onClick$={async (e) => {
                    const el = (e.target as HTMLElement).closest('[data-program-id]') as HTMLElement | null;
                    const id = el?.dataset.programId;
                    const prog = VERIFICATION_PROGRAMS.find(p => p.id === id);
                    if (prog) await selectProgram(prog);
                  }}
                  class="group relative p-3 sm:p-4 lg:p-6 bg-white border-2 border-gray-200 rounded-xl hover:border-[#965341] hover:shadow-lg transition-all duration-300 text-left min-h-[140px] sm:min-h-[160px] cursor-pointer"
                >
                  {/* Background gradient on hover */}
                  <div class="absolute inset-0 bg-gradient-to-br from-[#965341]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>

                  {/* Content */}
                  <div class="relative flex flex-col h-full">
                    {/* Program name */}
                    <h3 class="text-sm sm:text-base lg:text-lg font-bold text-gray-900 mb-2 sm:mb-3 group-hover:text-[#965341] transition-colors leading-tight">
                      {program.name}
                    </h3>

                    {/* Description */}
                    <p class="text-xs sm:text-sm text-gray-600 leading-relaxed mb-3 sm:mb-4 flex-grow">
                      {program.description}
                    </p>

                    {/* Bottom section with discount and arrow */}
                    <div class="flex items-center justify-between">
                      {/* Discount badge */}
                      <div class="inline-flex items-center bg-[#965341] text-white text-xs sm:text-sm font-bold px-2 sm:px-3 py-1 rounded-full">
                        {program.discountPercent}% OFF
                      </div>

                      {/* Arrow icon */}
                      <svg class="w-4 h-4 sm:w-5 sm:h-5 text-gray-400 group-hover:text-[#965341] transform group-hover:translate-x-1 transition-all duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* SheerID Modal - renders on top with higher z-index */}
      <SheerIdModal
        isOpen={showSheerIdModal.value}
        program={selectedProgram.value}
        onClose$={closeSheerIdModal}
      />
    </div>
  );
});
