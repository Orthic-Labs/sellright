// Removed: useLazySection, useLazySectionWithReveal, useViewportLoading
// These hooks used useVisibleTask$ internally. Replace usage with direct <Section/> rendering.
// CSS scroll-driven animations (data-reveal, animation-timeline:view()) replace JS reveal.
export {};
