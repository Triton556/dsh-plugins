import { ToolError, result, artifactPath } from './contracts.js';

// No default screenshot backend. Existing shot.ps1 PrintWindow is forbidden here.
// A provider must attest that it receives ONLY artifact pixels, not a full
// window image later cropped. Integration must independently verify the claim.
export function createCaptureAdapter({ frames, provider = null }) {
  return async cmd => {
    const e = frames.target(cmd.sessionId,cmd.args.target); artifactPath(e.path);
    if (!provider || provider.verifiedArtifactOnly !== true || provider.scope !== 'artifact-region' || typeof provider.capture !== 'function') throw new ToolError('CAPTURE_UNAVAILABLE','Verified artifact-region capture provider is not installed');
    const before = e.iframe.getBoundingClientRect();
    if (!before.width || !before.height || before.width > 4096 || before.height > 4096) throw new ToolError('CAPTURE_UNAVAILABLE','Artifact region is not a supported visible size');
    const image = await provider.capture({ sessionId:e.sessionId,tabId:e.tabId,documentId:e.documentId,artifactElement:e.iframe,deadline:cmd.deadline });
    const current = frames.target(cmd.sessionId,cmd.args.target);
    const after = current.iframe.getBoundingClientRect();
    if (['x','y','width','height'].some(k=>Math.abs(before[k]-after[k])>0.5)) throw new ToolError('CAPTURE_UNAVAILABLE','Artifact moved during capture; discarded');
    if (image.scope !== 'artifact-region' || image.documentId !== e.documentId || image.mimeType !== 'image/png' || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096 || typeof image.base64 !== 'string' || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(image.base64) || image.base64.length > 1400000) throw new ToolError('CAPTURE_UNAVAILABLE','Capture provider did not return a bounded artifact-only PNG');
    return result(e,'none',{image:{mimeType:image.mimeType,base64:image.base64,width:image.width,height:image.height}},null,cmd.id);
  };
}
