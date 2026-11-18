import { Button } from './Button';

export function PaletteSwatches({ colors, onPick }: { colors: string[]; onPick: (index: number, event: React.MouseEvent<HTMLButtonElement>) => void }) {
    return <div className="palette-swatches" aria-label="Recolor palette">{colors.map((color, index) =>
        <Button key={index} size="sm" className="palette-swatches__item" aria-label={`Palette color ${index + 1}`} title={`Edit palette color ${index + 1}`} onClick={event => onPick(index, event)}>
            <span className="palette-swatches__fill" style={{ background: color }} />
        </Button>
    )}</div>;
}
