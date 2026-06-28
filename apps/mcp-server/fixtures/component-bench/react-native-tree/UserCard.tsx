import React from 'react';
import { View, Text } from 'react-native';

interface UserCardProps { name: string; age: number; }

export function UserCard({ name, age }: UserCardProps) {
  return (
    <View>
      <Text>{name} ({age})</Text>
    </View>
  );
}
