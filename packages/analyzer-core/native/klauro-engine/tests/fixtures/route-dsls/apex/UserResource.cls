@RestResource(urlMapping='/users/*')
global with sharing class UserResource {

    @HttpGet
    global static List<User> doGet() {
        RestRequest req = RestContext.request;
        return [SELECT Id, Name FROM User LIMIT 50];
    }

    @HttpPost
    global static String doPost(String name, String email) {
        Account acct = new Account(Name = name);
        insert acct;
        return acct.Id;
    }

    @HttpDelete
    global static void doDelete() {
        RestRequest req = RestContext.request;
        String userId = req.requestURI.substring(req.requestURI.lastIndexOf('/') + 1);
    }
}
