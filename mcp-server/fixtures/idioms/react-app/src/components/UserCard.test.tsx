import { render, screen } from '@testing-library/react';
import { UserCard } from './UserCard';

it('renders user details', () => {
  render(<UserCard name="Ada" email="ada@example.com" />);
  expect(screen.getByText('Ada')).toBeTruthy();
});
