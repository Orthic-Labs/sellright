import { component$, useStyles$ } from '@qwik.dev/core';
import styles from './loading-spinner.css?inline';

export const LoadingSpinner = component$(() => {
  useStyles$(styles);

  return (
    <div class="loading-overlay">
      <div class="spinner"></div>
    </div>
  );
});
