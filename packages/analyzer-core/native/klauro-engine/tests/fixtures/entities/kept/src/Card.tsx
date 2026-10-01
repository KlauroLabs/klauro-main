import React from 'react';

interface CardProps {
  title: string;
  subtitle: string;
  onClose: () => void;
}

export function Card(props: CardProps) {
  return <div onClick={props.onClose}>{props.title}{props.subtitle}</div>;
}
