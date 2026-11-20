import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
export class LoginDto {
  @ApiProperty({ example: 'ada@example.com' }) @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value) @IsEmail() @MaxLength(254) email: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(72) password: string;
}
export class RegisterDto extends LoginDto {
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(72) declare password: string;
  @ApiProperty({ example: 'Ada Okafor' }) @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @MinLength(2) @MaxLength(80) name: string;
}
export class TransferDto {
  @ApiProperty() @IsMongoId() fromAccountId: string;
  @ApiProperty() @IsMongoId() toAccountId: string;
  @ApiProperty({ example: 250000, description: 'Whole kobo. 250000 means NGN 2,500.' }) @IsInt() @Min(100) @Max(100000000) amountKobo: number;
  @ApiProperty({ example: 'Monthly savings' }) @IsString() @MinLength(3) @MaxLength(100) description: string;
  @ApiProperty({ description: 'UUID retained when retrying this transfer' }) @IsUUID('4') key: string;
}
export class ExternalTransferDto {
  @ApiProperty() @IsMongoId() fromAccountId: string;
  @ApiProperty({ enum: ['test', 'access', 'first', 'gtb', 'uba', 'zenith'] }) @IsIn(['test', 'access', 'first', 'gtb', 'uba', 'zenith']) bankCode: string;
  @ApiProperty({ example: '0123456789' }) @Matches(/^\d{10}$/) accountNumber: string;
  @ApiProperty({ description: 'Amount in whole kobo' }) @IsInt() @Min(100) @Max(100000000) amountKobo: number;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(100) description: string;
  @ApiProperty({ description: 'UUID retained when retrying this transfer' }) @IsUUID('4') key: string;
}
export class ResolveBankAccountDto {
  @ApiProperty({ enum: ['test', 'access', 'first', 'gtb', 'uba', 'zenith'] }) @IsIn(['test', 'access', 'first', 'gtb', 'uba', 'zenith']) bankCode: string;
  @ApiProperty({ example: '1000000001' }) @Matches(/^\d{10}$/) accountNumber: string;
}
export class HistoryQuery {
  @ApiProperty({ required: false }) @IsOptional() @IsMongoId() accountId?: string;
  @ApiProperty({ required: false, enum: ['all', 'credit', 'debit'] }) @IsOptional() @IsIn(['all', 'credit', 'debit']) kind: string = 'all';
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(80) search: string = '';
  @ApiProperty({ required: false }) @Type(() => Number) @IsInt() @Min(1) @Max(10000) page: number = 1;
}
