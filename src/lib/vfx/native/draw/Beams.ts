import { RibbonDraw, type RibbonProps } from './RibbonDraw';
export type BeamsProps = RibbonProps;
export const Beams = (props: BeamsProps) => RibbonDraw(props, true);
