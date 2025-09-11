import { useCallback, useEffect, useRef, useState } from 'react';
import { DataSet, Network } from 'vis-network/standalone/esm/vis-network';
import { GraphData } from './types';



export default function Graph({ graphData }: { graphData: GraphData }) {
  const networkRef = useRef<HTMLDivElement>(null);
  const [network, setNetwork] = useState<Network | null>(null);

  const handleNodeClick = useCallback((params: { nodes: string[] }) => {
    if (params.nodes.length === 0) return;

    const clickedNodeId = params.nodes[0];
    const clickedNode = graphData.nodes.find(node => node.id === clickedNodeId);

    if (!clickedNode) return;

    // Prepare new DataSets for nodes and edges
    const nodesDataSet = new DataSet<{ id: string, label: string, color: string, shape: string }>();
    const edgesDataSet = new DataSet<{ id: string, from: string, to: string, arrows: string, label: string }>();

    // Add the clicked node
    nodesDataSet.add({
      id: clickedNode.id,
      label: clickedNode.id,
      color: getColorForNodeType(clickedNode.type),
      shape: 'box'
    });

    // Add directly connected nodes and relevant edges
    graphData.edges.forEach(edge => {
      if (edge.from === clickedNodeId || edge.to === clickedNodeId) {
        edgesDataSet.add({
          id: 'edge-' + edge.from + '-' + edge.to,
          from: edge.from,
          to: edge.to,
          arrows: 'to',
          label: edge.metadata?.property_name ? `(${edge.metadata.property_name})` : '',
        });
  
        // Add both source and target nodes if not already added
        [edge.from, edge.to].forEach(nodeId => {
          const node = graphData.nodes.find(n => n.id === nodeId);
          if (node && !nodesDataSet.get(nodeId)) { // Check if node exists and hasn't been added
            nodesDataSet.add({
              id: node.id,
              label: node.id,
              color: getColorForNodeType(node.type),
              shape: 'box'
            });
          }
        });
      }
    });
  
    // Reconfigure the network with updated DataSets
    if (networkRef.current) {
      const data = {
        nodes: nodesDataSet,
        edges: edgesDataSet
      };
      const options = {
        physics: false, // Disable physics for static layout
        edges: {
          font: { align: 'top' }
        }
      };
      const net = new Network(networkRef.current, data, options);
      net.on("click", handleNodeClick);
      setNetwork(net);
    }
  }, [graphData.edges, graphData.nodes]);
  
  const resetGraph = useCallback(() => {
    // Initially show only outermost items (nodes without parents or with specific criteria)
    const outerNodes = graphData.nodes.filter(node => !node.parents || node.parents.length === 0);
    const nodesDataSet = new DataSet(outerNodes.map(node => ({
      id: node.id,
      label: node.id,
      color: getColorForNodeType(node.type),
      hidden: false,
    })));

    const edgesDataSet = new DataSet([]);

    if (networkRef.current) {
      const data = { nodes: nodesDataSet, edges: edgesDataSet };
      const options = { physics: true }; // Consider disabling physics for a more organized layout
      const net = new Network(networkRef.current, data, options);
      net.on("click", handleNodeClick);
      setNetwork(net);
    }
  }, [graphData.nodes, handleNodeClick]);  

  useEffect(() => {
    resetGraph();
  }, [graphData, resetGraph]);

  return (
    <div>
      <button onClick={resetGraph} style={{ margin: '10px' }}>Reset Graph</button>
      <div ref={networkRef} style={{ height: '500px', width: '100%' }} />
    </div>
  );  
}

function getColorForNodeType(type: 'class' | 'method' | 'function'): string {
  switch (type) {
    case 'class':
      return '#FFC107'; // Example color for classes
    case 'method':
      return '#03A9F4'; // Example color for methods
    case 'function':
      return '#4CAF50'; // Example color for standalone functions
    default:
      return '#757575'; // Default color
  }
}