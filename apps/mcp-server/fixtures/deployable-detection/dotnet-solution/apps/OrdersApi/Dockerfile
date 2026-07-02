FROM mcr.microsoft.com/dotnet/sdk:8.0 as builder
WORKDIR /src
COPY . .
RUN dotnet publish apps/OrdersApi/OrdersApi.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:8.0
COPY --from=builder /out /app
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["dotnet", "OrdersApi.dll"]
