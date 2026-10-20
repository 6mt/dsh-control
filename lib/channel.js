/**
 * Channel preparation for one remote turn.
 *
 * Split out of the adapter (which imports runtime packages) so the ordering
 * rule is unit-testable: **the tunnel must be ensured before the connection is
 * used**. A local dsh can hold remote-session bindings across a restart; without
 * this step the first turn after a restart dies with
 * "隧道未建立或实例不可达：连接被拒绝" until some other screen happens to start it.
 */

/**
 * @param environment - environment name (the model id).
 * @param options.ensureChannel - async (environment) => {ok:true} | {ok:false, error}
 * @param options.connectionFor - environment => connection | undefined
 * @returns {{ok: true, connection: unknown} | {ok: false, error: string}}
 */
export async function prepareRemoteChannel(environment, { ensureChannel, connectionFor } = {}) {
	if (typeof ensureChannel === "function") {
		let ensured;
		try {
			ensured = await ensureChannel(environment);
		} catch (error) {
			ensured = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (ensured !== undefined && ensured?.ok === false) {
			return { ok: false, error: ensured.error ?? `远程环境「${environment}」的通道未就绪` };
		}
	}
	const connection = typeof connectionFor === "function" ? connectionFor(environment) : undefined;
	if (connection === undefined) return { ok: false, error: `远程环境「${environment}」未连接` };
	return { ok: true, connection };
}
