import { component$ } from '@qwik.dev/core';

export const OrdersSkeleton = component$(() => (
  <div class="max-w-7xl mx-auto px-4 py-8">
    <div class="mb-8">
      <div class="h-8 bg-gray-200 rounded w-1/4 mb-2 animate-pulse"></div>
      <div class="h-4 bg-gray-200 rounded w-1/2 animate-pulse"></div>
    </div>
    <div class="space-y-6">
      {[...Array(3)].map((_, i) => (
        <div key={i} class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div class="p-6 border-b border-gray-100">
            <div class="flex items-center justify-between animate-pulse">
              <div class="flex items-center space-x-4">
                <div class="w-4 h-4 bg-gray-200 rounded"></div>
                <div>
                  <div class="h-5 bg-gray-200 rounded w-32 mb-2"></div>
                  <div class="h-3 bg-gray-200 rounded w-24"></div>
                </div>
                <div class="w-16 h-6 bg-gray-200 rounded-full"></div>
              </div>
              <div class="text-right">
                <div class="h-5 bg-gray-200 rounded w-20 mb-2"></div>
                <div class="h-3 bg-gray-200 rounded w-16"></div>
              </div>
            </div>
          </div>
          <div class="p-6">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div class="lg:col-span-2 space-y-3">
                {[...Array(2)].map((_, j) => (
                  <div key={j} class="flex items-center space-x-4 p-3 bg-gray-50 rounded-lg animate-pulse">
                    <div class="w-12 h-12 bg-gray-200 rounded-lg"></div>
                    <div class="flex-1">
                      <div class="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                      <div class="h-3 bg-gray-200 rounded w-1/2"></div>
                    </div>
                  </div>
                ))}
              </div>
              <div class="space-y-4">
                <div class="bg-gray-50 rounded-lg p-4 animate-pulse">
                  <div class="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
                  <div class="h-3 bg-gray-200 rounded w-full mb-1"></div>
                  <div class="h-3 bg-gray-200 rounded w-3/4"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
));
