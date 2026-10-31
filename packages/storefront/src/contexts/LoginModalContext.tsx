import { 
  createContextId, 
  useContext, 
  useContextProvider, 
  component$, 
  Slot, 
  useStore,
  $,
  QRL
} from '@qwik.dev/core';

import type { Live } from '~/sellright/types/live';

export interface LoginModalState extends Live {
  isOpen: boolean;
  /** #360: set by the first opener; the layout mounts the modal (and loads its chunk) only from then on. */
  everOpened: boolean;
  onLoginSuccess?: QRL<() => void>;
}

export interface LoginModalActions {
  openLoginModal: QRL<(onSuccess?: QRL<() => void>) => void>;
  closeLoginModal: QRL<() => void>;
}

export interface LoginModalContextType extends Live {
  state: LoginModalState;
  actions: LoginModalActions;
}

// Create context
export const LoginModalContextId = createContextId<LoginModalContextType>('login-modal-context');

// Hook to use the context
export const useLoginModal = () => useContext(LoginModalContextId);

// Initial state
const createInitialState = (): LoginModalState => ({
  isOpen: false,
  everOpened: false,
  onLoginSuccess: undefined,
});

// Provider component
export const LoginModalProvider = component$(() => {
  const state = useStore<LoginModalState>(createInitialState());

  // Actions
  const openLoginModal = $((onSuccess?: QRL<() => void>) => {
    state.everOpened = true;
    state.isOpen = true;
    state.onLoginSuccess = onSuccess;
  });

  const closeLoginModal = $(() => {
    state.isOpen = false;
    state.onLoginSuccess = undefined;
  });

  const actions: LoginModalActions = {
    openLoginModal,
    closeLoginModal,
  };

  const contextValue: LoginModalContextType = {
    state,
    actions,
  };

  useContextProvider(LoginModalContextId, contextValue);

  return <Slot />;
});

// Convenience hooks for common use cases
export const useLoginModalActions = () => {
  const { actions } = useLoginModal();
  return actions;
};

export const useLoginModalState = () => {
  const { state } = useLoginModal();
  return state;
};
