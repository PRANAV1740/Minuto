import { modelAvailable } from './actions.ts';
import { Workbench } from './workbench.tsx';

export default async function Home() {
  // Resolved on the server so the form can say honestly whether a model is
  // configured, rather than offering a toggle that silently does nothing.
  const model = await modelAvailable();

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Minuto</h1>
        <p className="standfirst">
          Paste a transcript and get minutes where every decision and task cites the moment it came
          from. Nothing is invented: anything the pipeline cannot trace is dropped or flagged.
        </p>
      </header>

      <Workbench model={model} />
    </div>
  );
}
