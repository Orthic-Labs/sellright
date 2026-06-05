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

export interface LoginModalState {
  isOpen: boolean;
  onLoginSuccess?: QRL<() => void>;
}

export interface LoginModalActions {
  openLoginModal: QRL<(onSuccess?: QRL<() => void>) => void>;
  closeLoginModal: QRL<() => void>;
}

export interface LoginModalContextType {
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
  onLoginSuccess: undefined,
});

// Provider component
export const LoginModalProvider = component$(() => {
  const state = useStore<LoginModalState>(createInitialState());

  // Actions
  const openLoginModal = $((onSuccess?: QRL<() => void>) => {
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
