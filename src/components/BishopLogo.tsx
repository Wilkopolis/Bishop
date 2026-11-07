import bishopSvg from '../assets/chess_bishop.svg?raw';

// Kenney's chess bishop (CC0). The source SVG has no viewBox; its path is centered on 0,0.
const PATH = /\sd="([^"]+)"/.exec(bishopSvg)?.[1] ?? '';

/**
 * The Bishop chess-piece mark, filled with currentColor so it themes.
 * boxHeight makes the svg taller without scaling the mark, which stays centered in it.
 */
export function BishopLogo({ size = 16, boxHeight = size, className }: { size?: number; boxHeight?: number; className?: string }) {
  const viewHeight = (72 * boxHeight) / size;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`-26 ${-viewHeight / 2} 52 ${viewHeight}`}
      width={size}
      height={boxHeight}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d={PATH} />
    </svg>
  );
}
