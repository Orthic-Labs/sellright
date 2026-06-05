/// <reference types="vite/client" />

// Vite-imagetools picture directive
declare module "~/media/hero.png?w=768;1024;1440&format=avif;webp;jpg&quality=85&as=picture" {
  interface ImageSource {
    src: string;
    w: number;
    h: number;
  }

  interface PictureOutput {
    sources: {
      [format: string]: ImageSource[];
    };
    img: ImageSource;
  }

  const picture: PictureOutput;
  export default picture;
}

// Vite image import types - specific patterns with AVIF support
declare module "~/media/hero.png?format=avif&quality=85&url" {
  const src: string;
  export default src;
}

declare module "~/media/hero.png?format=webp&quality=85&url" {
  const src: string;
  export default src;
}

declare module "~/media/hero.png?format=jpeg&quality=95&url" {
  const src: string;
  export default src;
}

declare module "~/media/2.png?format=avif&quality=85&url" {
  const src: string;
  export default src;
}

declare module "~/media/2.png?format=webp&quality=85&url" {
  const src: string;
  export default src;
}

declare module "~/media/2.png?format=jpeg&quality=95&url" {
  const src: string;
  export default src;
}

declare module "~/media/homelast.png?format=avif&quality=85&url" {
  const src: string;
  export default src;
}

declare module "~/media/homelast.png?format=webp&quality=85&url" {
  const src: string;
  export default src;
}

declare module "~/media/homelast.png?format=jpeg&quality=95&url" {
  const src: string;
  export default src;
}

// Legacy WebP declarations
declare module "~/media/hero.png?format=webp&url" {
  const src: string;
  export default src;
}

declare module "~/media/slider1.png?format=webp&url" {
  const src: string;
  export default src;
}

declare module "~/media/slider2.png?format=webp&url" {
  const src: string;
  export default src;
}

declare module "~/media/slider 3.jpg?format=webp&url" {
  const src: string;
  export default src;
}

declare module "~/media/2.png?format=webp&url" {
  const src: string;
  export default src;
}

declare module "~/media/homelast.png?format=webp&url" {
  const src: string;
  export default src;
}

// Generic patterns for future images
declare module "*.png?*&format=webp&url" {
  const src: string;
  export default src;
}

declare module "*.jpg?*&format=webp&url" {
  const src: string;
  export default src;
}

declare module "*.jpeg?*&format=webp&url" {
  const src: string;
  export default src;
}

declare module "*.webp?*&format=webp&url" {
  const src: string;
  export default src;
}

// AVIF format declarations
declare module "*.png?format=avif&*" {
  const src: string;
  export default src;
}

declare module "*.jpg?format=avif&*" {
  const src: string;
  export default src;
}

declare module "*.jpeg?format=avif&*" {
  const src: string;
  export default src;
}

// WebP with quality declarations
declare module "*.png?format=webp&*" {
  const src: string;
  export default src;
}

declare module "*.jpg?format=webp&*" {
  const src: string;
  export default src;
}

declare module "*.jpeg?format=webp&*" {
  const src: string;
  export default src;
}

// JPEG with quality declarations
declare module "*.png?format=jpeg&*" {
  const src: string;
  export default src;
}

declare module "*.jpg?format=jpeg&*" {
  const src: string;
  export default src;
}

declare module "*.jpeg?format=jpeg&*" {
  const src: string;
  export default src;
}

// Catch-all per media file — covers any quality/width/format combination
declare module "~/media/hero.png?*" { const src: string; export default src; }
declare module "~/media/hero.jpg?*" { const src: string; export default src; }
declare module "~/media/2.png?*" { const src: string; export default src; }
declare module "~/media/sec2.jpg?*" { const src: string; export default src; }
declare module "~/media/homelast.png?*" { const src: string; export default src; }
