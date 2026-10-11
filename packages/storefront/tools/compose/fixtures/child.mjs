// Static child process for the journal tests: the scenario and its data arrive as one JSON argument, never as generated source.
import { beginJournal, recoverJournals } from '../lib/journal.mjs';
import { safeWrite, writeHooks } from '../lib/util.mjs';

const { scenario, brandRepo, roots, out, history, killIn } = JSON.parse(process.argv[2]);
const kill = () => process.kill(process.pid, 'SIGKILL');

if (scenario === 'killed-write') {
	beginJournal({ brandRepo, roots, paths: [{ root: 'out', rel: 'a.txt' }, { root: 'out', rel: 'b/new.txt' }] });
	safeWrite(out, 'a.txt', 'complete write');
	// killed right after the temporary of the next write is complete, before its rename
	writeHooks.afterTemp = kill;
	safeWrite(out, 'b/new.txt', 'half');
} else if (scenario === 'prepare') {
	const j = beginJournal({ brandRepo, roots, paths: [{ root: 'out', rel: 'a.txt' }] });
	j.setHistory('h1');
	safeWrite(out, 'a.txt', 'changed by the interrupted apply');
} else if (scenario === 'killed-recovery') {
	// recovery itself is killed inside a write: restoring a.txt, or marking the history entry abandoned
	if (killIn === 'restore') writeHooks.afterTemp = kill;
	recoverJournals({
		brandRepo,
		roots,
		markAbandoned: (id) => {
			writeHooks.afterTemp = kill;
			safeWrite(history, `${id}/meta.json`, '{"status":"abandoned"}');
		},
	});
} else if (scenario === 'apply') {
	beginJournal({ brandRepo, roots, paths: [{ root: 'out', rel: 'a.txt' }] });
	writeHooks.afterTemp = kill;
	safeWrite(out, 'a.txt', 'half');
} else if (scenario === 'recover-first') {
	writeHooks.afterTemp = kill;
	recoverJournals({ brandRepo, roots, markAbandoned: () => {} });
} else {
	throw new Error(`unknown scenario ${scenario}`);
}
