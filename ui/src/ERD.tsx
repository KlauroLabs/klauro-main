import { useEffect, useState } from 'react';
import { ERDData } from './types';
import createEngine, {
  DefaultLinkModel,
  DefaultNodeModel,
  DiagramEngine,
  DiagramModel
} from '@projectstorm/react-diagrams';
import { CanvasWidget } from '@projectstorm/react-canvas-core';
import styled from '@emotion/styled';

const FullscreenCanvas = styled(CanvasWidget)`
  height: 500px;
  width: 800px;
`;

export default function ERD(props: { erdData: ERDData }) {
  const [engine, setEngine] = useState<DiagramEngine | null>(null);
  const [model, setModel] = useState<DiagramModel | null>(null);

  useEffect(() => {
    const newEngine = createEngine();
    setEngine(newEngine);
  }, []);

  useEffect(() => {
    if (!engine) return;

    const setupDiagram = () => {
      const newModel = new DiagramModel();
      const nodesMap = new Map();

      try {
        props.erdData.models.forEach((modelData) => {
          const node = new DefaultNodeModel({
            name: modelData.name,
            color: 'rgb(0,192,255)',
          });

          const x = Math.random() * 800;
          const y = Math.random() * 500;
          node.setPosition(x, y);

          modelData.fields.forEach((field) => {
            node.addOutPort(`${field}`);
          });

          nodesMap.set(modelData.name, node);
          newModel.addNode(node);
        });

        props.erdData.models.forEach((modelData) => {
          modelData.relationships.forEach((rel) => {
            const sourceNode = nodesMap.get(modelData.name);
            const targetNode = nodesMap.get(rel.related_model);

            if (sourceNode && targetNode) {
              const link = new DefaultLinkModel();
              link.setSourcePort(sourceNode.getPort(rel.field_name));
              const targetPort = targetNode.getPort(rel.field_name);
              if (targetPort) {
                link.setTargetPort(targetPort);
                newModel.addLink(link);
              }
              else {
                // if port is not found, add an ID port to the target node
                targetNode.addInPort(rel.field_name);
                link.setTargetPort(targetNode.getPort(rel.field_name));
                newModel.addLink(link);
              }
            }
          });
        });

        engine.setModel(newModel);
        setModel(newModel); // Update the model state
      } catch (error) {
        console.error('Error setting up diagram:', error);
      }
    };

    setupDiagram();
  }, [engine, props.erdData]);

  if (!engine || !model) return <div>Loading...</div>;

  return <FullscreenCanvas engine={engine} />;
}