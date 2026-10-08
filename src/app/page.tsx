import { config } from '@/lib/config';
import { Workspace } from '@/components/Workspace';
export const dynamic='force-dynamic';
export default function Home() { return <Workspace initialMode={config().mode}/>; }
