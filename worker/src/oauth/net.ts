// Every outbound request of the OAuth code (CIMD documents) goes through here, so tests can stub it.
export const outbound = {
  fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init),
};
