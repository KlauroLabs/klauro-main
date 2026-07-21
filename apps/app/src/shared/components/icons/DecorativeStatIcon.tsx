import { forwardRef } from 'react';

const WIREFRAME = '#B7BCC7';
const STROKE = 1.25;

export type DecorativeStat = 'capabilities' | 'entryPoints' | 'contributors' | 'age';

const GLYPHS: Record<DecorativeStat, string> = {

  capabilities: 'M12 3l8 5v8l-8 5-8-5V8zM12 3v9M4 8l8 4 8-4M12 21v-9',

  entryPoints: 'M7 3h7l4 4v14H7zM14 3v4h4M9.5 13l-2 2 2 2M13.5 13l2 2-2 2',

  contributors: 'M4 18a10 10 0 0 1 16-8M4 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM20 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',

  age: 'M4 4h11v11H4zM9 9h11v11H9z',
};

export interface DecorativeStatIconProps {
  stat: DecorativeStat;
  size?: number;
  titleText?: string;
}

export const DecorativeStatIcon = forwardRef<SVGSVGElement, DecorativeStatIconProps>(function DecorativeStatIcon(
  { stat, size = 28, titleText },
  ref,
) {
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={titleText ?? stat}
    >
      {titleText ? <title>{titleText}</title> : null}
      <path d={GLYPHS[stat]} stroke={WIREFRAME} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});
