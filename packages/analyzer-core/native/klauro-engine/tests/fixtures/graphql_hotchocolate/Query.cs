using HotChocolate;
using HotChocolate.Types;
[QueryType]
public static class UserQueries {
    public static string GetUser(string id) => id;
    public static string Users() => "";
}
[ExtendObjectType(OperationTypeNames.Mutation)]
public class UserMutations {
    public string CreateUserAsync(string email) => email;
}
