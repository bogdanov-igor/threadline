import { Tooltip } from '@/components/ui/tooltip.tsx';
import { useTruncated } from '@/lib/use-truncated.ts';
import { cn } from '@/lib/utils.ts';

export function TruncatedLabel({ text, className }: { text: string; className?: string }) {
  const { ref, truncated } = useTruncated<HTMLSpanElement>();
  return (
    <Tooltip content={text} disabled={!truncated}>
      <span ref={ref} className={cn('block truncate', className)} tabIndex={truncated ? 0 : undefined}>
        {text}
      </span>
    </Tooltip>
  );
}
