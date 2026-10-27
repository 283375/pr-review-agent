export interface Artifact {
  entry: string
  outfile: string
  action: string
  actionRef: string
  /** Path from the bundle's directory back to the repository root. */
  actionRoot?: string
}

export const artifacts: Artifact[]
export const reviewArtifact: Artifact
export const gateRoots: string[]
