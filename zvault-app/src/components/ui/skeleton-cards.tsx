"use client";

import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse bg-gray/10 rounded",
        className
      )}
    />
  );
}

export function DepositFlowSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden="true">
      {/* Mode toggle skeleton */}
      <div className="flex gap-2 p-1 bg-muted rounded-[10px]">
        <div className="flex-1 h-10 bg-gray/10 rounded-[8px]" />
        <div className="flex-1 h-10 bg-gray/10 rounded-[8px]" />
      </div>

      {/* Stealth address section skeleton */}
      <div className="p-3 bg-privacy/5 border border-privacy/15 rounded-[12px]">
        <div className="h-4 bg-gray/10 rounded w-1/3 mb-2" />
        <div className="h-8 bg-gray/10 rounded w-full" />
      </div>

      {/* Input section skeleton */}
      <div>
        <div className="h-4 bg-gray/10 rounded w-1/4 mb-2" />
        <div className="h-12 bg-gray/10 rounded-[12px]" />
      </div>

      {/* Button skeleton */}
      <div className="h-12 bg-gray/10 rounded-[12px]" />
    </div>
  );
}

export function AddressDisplaySkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden="true">
      {/* Address box skeleton */}
      <div className="p-4 bg-btc/5 rounded-[12px]">
        <div className="flex items-center justify-between mb-2">
          <div className="h-4 bg-gray/10 rounded w-1/4" />
          <div className="flex gap-1">
            <div className="w-8 h-8 bg-gray/10 rounded-[6px]" />
            <div className="w-8 h-8 bg-gray/10 rounded-[6px]" />
          </div>
        </div>
        <div className="h-6 bg-gray/10 rounded w-full" />
      </div>

      {/* QR code placeholder */}
      <div className="flex justify-center p-4">
        <div className="w-[180px] h-[180px] bg-gray/10 rounded-lg" />
      </div>

      {/* Secret section skeleton */}
      <div className="p-4 bg-muted rounded-[12px]">
        <div className="h-4 bg-gray/10 rounded w-1/3 mb-2" />
        <div className="h-6 bg-gray/10 rounded w-3/4" />
      </div>
    </div>
  );
}

export function FeatureCardSkeleton() {
  return (
    <div className="p-4 bg-muted rounded-[16px] animate-pulse" aria-hidden="true">
      <div className="w-10 h-10 bg-gray/10 rounded-full mb-3" />
      <div className="h-5 bg-gray/10 rounded w-2/3 mb-2" />
      <div className="h-4 bg-gray/10 rounded w-full mb-1" />
      <div className="h-3 bg-gray/10 rounded w-1/2" />
    </div>
  );
}

export function BridgePageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      {/* Title section */}
      <div className="text-center">
        <div className="h-8 bg-gray/10 rounded w-1/2 mx-auto mb-2" />
        <div className="h-4 bg-gray/10 rounded w-2/3 mx-auto" />
      </div>

      {/* Stealth address section */}
      <div className="p-4 bg-muted rounded-[16px]">
        <div className="h-5 bg-gray/10 rounded w-1/3 mb-4" />
        <div className="h-10 bg-gray/10 rounded w-full mb-2" />
        <div className="h-4 bg-gray/10 rounded w-2/3" />
      </div>

      {/* Feature cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <FeatureCardSkeleton key={i} />
        ))}
      </div>

      {/* Info section */}
      <div className="p-4 bg-muted rounded-[12px]">
        <div className="h-4 bg-gray/10 rounded w-full mb-2" />
        <div className="h-4 bg-gray/10 rounded w-3/4" />
      </div>
    </div>
  );
}
