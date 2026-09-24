import { RibbonDraw, type RibbonProps } from './RibbonDraw';
export type TrailsProps = RibbonProps;
export const Trails = (props: TrailsProps) => RibbonDraw(props, false);
