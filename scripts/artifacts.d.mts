export interface Artifact {
  entry: string
  outfile: string
  action: string
  actionRef: string
}

export const artifacts: Artifact[]
export const gateRoots: string[]
