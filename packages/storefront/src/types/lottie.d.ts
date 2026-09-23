// lottie-player custom element declaration
declare namespace JSX {
  interface IntrinsicElements {
    'lottie-player': {
      src?: string;
      style?: string;
      loop?: boolean;
      autoplay?: boolean;
      class?: string;
      speed?: number;
      direction?: number;
      mode?: string;
      background?: string;
      controls?: boolean;
      hover?: boolean;
      click?: boolean;
      intermission?: number;
      count?: number;
    };
  }
}
