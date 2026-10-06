// Real subject and a Proxy controlling access to it.
export interface ImageSource { load(): string; }

export class RemoteImage implements ImageSource {
  load(): string { return 'pixels'; }
}

export class ImageProxy implements ImageSource {
  private real?: RemoteImage;
  constructor(private url: string) {}
  load(): string {
    if (!this.real) this.real = new RemoteImage();
    return this.real.load();
  }
}

// Visitor traversing a node structure.
export interface Node { accept(v: NodeVisitor): void; }

export class RenderVisitor implements NodeVisitor {
  visitText(t: string): void { /* render */ }
  visitImage(u: string): void { /* render */ }
}
export interface NodeVisitor { visitText(t: string): void; visitImage(u: string): void; }
