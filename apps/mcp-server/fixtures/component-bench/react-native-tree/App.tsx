import React from 'react';
import { View } from 'react-native';
import { UserCard } from './UserCard';

export function App() {
  return (
    <View>
      <UserCard name="Ada" age={36} />
    </View>
  );
}
