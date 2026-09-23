import { component$ } from '@qwik.dev/core';

interface SkeletonProps {
 class?: string;
 variant?: 'text' | 'circular' | 'rectangular';
 width?: string;
 height?: string;
}

/**
 * Skeleton loading component for better perceived performance
 * Provides visual feedback while content loads
 */
export const Skeleton = component$<SkeletonProps>(({ 
 class: className = '',
 variant = 'rectangular',
 width = 'w-full',
 height = 'h-4'
}) => {
 const baseClasses = 'animate-pulse bg-gray-200 rounded-sm';
 
 const variantClasses = {
 text: 'h-4 rounded-sm',
 circular: 'rounded-full',
 rectangular: 'rounded-sm'
 };

 return (
 <div 
  class={`${baseClasses} ${variantClasses[variant]} ${width} ${height} ${className}`}
  aria-label="Loading..."
  role="status"
 />
 );
});
