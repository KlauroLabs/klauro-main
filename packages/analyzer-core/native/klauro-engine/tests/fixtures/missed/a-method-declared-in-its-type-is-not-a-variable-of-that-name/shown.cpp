struct walker {
  template <class Fnc> void visit(const Fnc& fnc) const;
  template <class Ptr, class Fnc> void step(const Ptr& ptr, const Fnc& fnc) const;
};
template <class Fnc> void walker::visit(const Fnc& fnc) const { step(0, fnc); }
template <class Ptr, class Fnc> void walker::step(const Ptr& ptr, const Fnc& fnc) const {}
