package A is
  type User is record
    Name : String;
  end record;
  function Send (Dest : String) return Boolean;
end A;
